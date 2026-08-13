// FINDING #14 — portal uploads are scanned, intake never refuses, filing is
// fail-closed.
//
// Brian's ruling in one sentence: a wedged scanner must cost TIME, not uploads.
// So the tests are organised around who bears the cost of our infrastructure being
// broken. The client must never bear it at intake; the document must not silently
// count as delivered either.
//
// The scanner here is a real TCP server speaking clamd's INSTREAM protocol rather
// than a stubbed scanBuffer(), so the wire format in scan.ts is exercised too — a
// mock of my own function would have proved only that I can call it.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import type { Mailer } from '../src/mailer.ts';
import { createTestConfig, makeContact, makeStaff, multipartBody } from './helpers.ts';
import * as OTPAuth from 'otpauth';
import { runDocumentRescanJob } from '../src/modules/documents/rescan.ts';
import { makeMinioClient } from '../src/modules/documents/storage.ts';
import type { Config } from '../src/config.ts';

let app: FastifyInstance;
let config: Config;
let clamd: Server;
let clamdPort: number;

/** Flipped per test: what the fake clamd reports for the next scan. */
let verdict: 'clean' | 'infected' = 'clean';

const silentMailer: Mailer = { transport: 'console', async send() { return { id: 'silent' }; } };

/** A minimal clamd: read an INSTREAM upload, answer, close. */
function startClamd(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((sock) => {
      // ACCUMULATE. TCP gives no guarantee about chunk boundaries, and the first
      // version of this fake inspected each chunk in isolation: if the four
      // zero bytes that terminate an INSTREAM arrived split across two reads —
      // which happens under full-suite load and not when this file runs alone —
      // the fake never answered, scanBuffer hit its 20s timeout, and a 'clean'
      // test flaked to 'skipped'. A flaky test is worse than no test.
      let seen = Buffer.alloc(0);
      sock.on('data', (chunk) => {
        seen = Buffer.concat([seen, chunk]);

        // The reachability probe speaks PING/PONG, not INSTREAM. A fake that only
        // knows one command reports the scanner as unreachable and quietly
        // invalidates the dependency-health tests.
        if (seen.includes('PING')) {
          sock.write('PONG\0');
          sock.end();
          return;
        }
        // An INSTREAM ends with a zero-length chunk: four zero bytes, judged
        // against everything received so far rather than the latest read.
        if (seen.length >= 4 && seen.readUInt32BE(seen.length - 4) === 0) {
          sock.write(
            verdict === 'clean'
              ? 'stream: OK\0'
              : 'stream: Win.Test.EICAR_HDB-1 FOUND\0'
          );
          sock.end();
        }
      });
      sock.on('error', () => { /* client hung up; nothing to do */ });
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: (server.address() as { port: number }).port });
    });
  });
}

async function portalClient(name: string) {
  const email = `${name.toLowerCase()}@example.test`;
  const c = await makeContact(app.db, { firstName: 'Synthetic', lastName: name, email });
  const pu = await app.db.query<{ id: string }>(
    `INSERT INTO portal_users (contact_id, email) VALUES ($1, $2) RETURNING id`,
    [c.id, email]
  );
  const token = randomBytes(32).toString('base64url');
  await app.db.query(
    `INSERT INTO portal_sessions (portal_user_id, token_hash, expires_at)
     VALUES ($1, $2, now() + interval '1 hour')`,
    [pu.rows[0]!.id, createHash('sha256').update(token).digest('hex')]
  );
  return { contactId: c.id, cookie: { cookie: `saos_portal_session=${token}` } };
}

const BYTES = Buffer.from('%PDF-1.4 synthetic\n%%EOF');

function upload(cookie: { cookie: string }, fields: Record<string, string>) {
  const mp = multipartBody(fields, {
    field: 'file',
    filename: 'w2.pdf',
    contentType: 'application/pdf',
    data: BYTES,
  });
  return { payload: mp.payload, headers: { ...mp.headers, ...cookie } };
}

/** A document request with one item, the thing "filing" completes. */
async function requestOneItem(contactId: string) {
  const req = await app.db.query<{ id: string }>(
    `INSERT INTO document_requests (contact_id, title_en) VALUES ($1, 'Send your W-2') RETURNING id`,
    [contactId]
  );
  const item = await app.db.query<{ id: string }>(
    `INSERT INTO document_request_items (request_id, label_en) VALUES ($1, 'W-2') RETURNING id`,
    [req.rows[0]!.id]
  );
  return item.rows[0]!.id;
}

async function scanRow(id: string) {
  const { rows } = await app.db.query<{
    scan_status: string; scan_detail: string | null; scan_attempts: number;
    scanned_at: string | null; pending_request_item_id: string | null;
  }>(
    `SELECT scan_status::text AS scan_status, scan_detail, scan_attempts, scanned_at,
            pending_request_item_id
     FROM documents WHERE id = $1`,
    [id]
  );
  return rows[0]!;
}

before(async () => {
  const started = await startClamd();
  clamd = started.server;
  clamdPort = started.port;
  config = await createTestConfig('docscan');
  config.CLAMAV_HOST = '127.0.0.1';
  config.CLAMAV_PORT = clamdPort;
  app = buildServer(config, { mailer: silentMailer });
  await app.ready();
});

after(async () => {
  await app.close();
  await new Promise<void>((r) => clamd.close(() => r()));
});

test('a clean upload files immediately — the normal path is unchanged', async () => {
  verdict = 'clean';
  const { contactId, cookie } = await portalClient('CleanPath');
  const itemId = await requestOneItem(contactId);

  const res = await app.inject({
    method: 'POST',
    url: '/portal/documents',
    ...upload(cookie, { category: 'tax_documents', documentRequestItemId: itemId }),
  });
  assert.equal(res.statusCode, 201, res.body);
  const { id } = res.json() as { id: string };

  const row = await scanRow(id);
  assert.equal(row.scan_status, 'clean');
  assert.equal(row.scan_attempts, 1);
  assert.ok(row.scanned_at, 'the verdict is timestamped');
  assert.equal(row.pending_request_item_id, null, 'nothing deferred');

  const item = await app.db.query<{ status: string; document_id: string | null }>(
    `SELECT status::text AS status, document_id FROM document_request_items WHERE id = $1`,
    [itemId]
  );
  assert.equal(item.rows[0]!.status, 'received', 'a clean file files on the spot');
  assert.equal(item.rows[0]!.document_id, id);
});

test('INTAKE NEVER REFUSES: a dead scanner still accepts and stores the upload', async () => {
  // Point at a port with nothing on it — the wedged-clamd case, for real.
  const realPort = config.CLAMAV_PORT;
  config.CLAMAV_PORT = 1; // connect refused
  try {
    const { contactId, cookie } = await portalClient('DeadScanner');
    const itemId = await requestOneItem(contactId);

    const res = await app.inject({
      method: 'POST',
      url: '/portal/documents',
      ...upload(cookie, { category: 'tax_documents', documentRequestItemId: itemId }),
    });
    assert.equal(res.statusCode, 201, 'the client is NOT punished for our scanner being down');
    const { id } = res.json() as { id: string };

    const row = await scanRow(id);
    assert.equal(row.scan_status, 'skipped');
    assert.match(row.scan_detail ?? '', /unreachable/, 'and the reason is recorded, not lost');

    // FAIL-CLOSED AT FILING: stored, visible, but it does not count as delivered.
    const item = await app.db.query<{ status: string }>(
      `SELECT status::text AS status FROM document_request_items WHERE id = $1`,
      [itemId]
    );
    assert.notEqual(item.rows[0]!.status, 'received', 'a skipped scan is not a pass');
    assert.equal(row.pending_request_item_id, itemId, 'the filing is remembered, not dropped');

    // The client can still see and retrieve what they just sent.
    const dl = await app.inject({ method: 'GET', url: `/portal/documents/${id}/download`, headers: cookie });
    assert.equal(dl.statusCode, 200, 'an unscanned file is still the client’s own file');
  } finally {
    config.CLAMAV_PORT = realPort;
  }
});

test('the rescan job completes the deferred filing once the scanner returns', async () => {
  const realPort = config.CLAMAV_PORT;
  config.CLAMAV_PORT = 1;
  let id: string;
  let itemId: string;
  let contactId: string;
  try {
    const c = await portalClient('ScannerReturns');
    contactId = c.contactId;
    itemId = await requestOneItem(contactId);
    const res = await app.inject({
      method: 'POST',
      url: '/portal/documents',
      ...upload(c.cookie, { category: 'tax_documents', documentRequestItemId: itemId }),
    });
    assert.equal(res.statusCode, 201);
    id = (res.json() as { id: string }).id;
    assert.equal((await scanRow(id)).scan_status, 'skipped');
  } finally {
    config.CLAMAV_PORT = realPort; // clamd is back
  }

  verdict = 'clean';
  const summary = await runDocumentRescanJob(app, makeMinioClient(config));
  assert.ok(summary.considered >= 1, 'the job found the outstanding document');
  assert.ok(summary.clean >= 1);
  assert.ok(summary.filed >= 1, 'and completed the filing that was waiting');

  const row = await scanRow(id);
  assert.equal(row.scan_status, 'clean');
  assert.equal(row.scan_attempts, 2, 'the retry is counted, not overwritten');
  assert.equal(row.pending_request_item_id, null, 'the deferred target is cleared');

  const item = await app.db.query<{ status: string; document_id: string | null }>(
    `SELECT status::text AS status, document_id FROM document_request_items WHERE id = $1`,
    [itemId]
  );
  assert.equal(item.rows[0]!.status, 'received', 'the client stops being chased for it');
  assert.equal(item.rows[0]!.document_id, id);
});

test('an infected upload is accepted, quarantined, undownloadable, and raises a task', async () => {
  verdict = 'infected';
  const { contactId, cookie } = await portalClient('Infected');
  const itemId = await requestOneItem(contactId);

  const res = await app.inject({
    method: 'POST',
    url: '/portal/documents',
    ...upload(cookie, { category: 'tax_documents', documentRequestItemId: itemId }),
  });
  assert.equal(res.statusCode, 201, 'intake never refuses — not even this');
  const { id } = res.json() as { id: string };

  const row = await scanRow(id);
  assert.equal(row.scan_status, 'infected');
  assert.match(row.scan_detail ?? '', /EICAR/, 'the signature name is kept');

  const item = await app.db.query<{ status: string }>(
    `SELECT status::text AS status FROM document_request_items WHERE id = $1`,
    [itemId]
  );
  assert.notEqual(item.rows[0]!.status, 'received', 'an infected file never satisfies a request');

  // Nobody downloads malware — not staff, not the client who sent it.
  const dl = await app.inject({ method: 'GET', url: `/portal/documents/${id}/download`, headers: cookie });
  assert.equal(dl.statusCode, 409, dl.body);

  const task = await app.db.query<{ title: string; source_type: string }>(
    `SELECT title, source_type FROM tasks WHERE source_type = 'document_infected' AND source_id = $1`,
    [id]
  );
  assert.equal(task.rowCount, 1, 'exactly one task, owned by someone');

  // And the client was told nothing by the machine.
  const msgs = await app.db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM messages m JOIN message_threads t ON t.id = m.thread_id
     WHERE t.contact_id = $1`,
    [contactId]
  );
  assert.equal(msgs.rows[0]!.n, 0, 'no automated "your file has a virus" message');
  verdict = 'clean';
});

test('every verdict leaves an audit row, including the skipped ones', async () => {
  const realPort = config.CLAMAV_PORT;
  config.CLAMAV_PORT = 1;
  let id: string;
  try {
    const c = await portalClient('AuditedSkip');
    const res = await app.inject({
      method: 'POST', url: '/portal/documents', ...upload(c.cookie, { category: 'tax_documents' }),
    });
    id = (res.json() as { id: string }).id;
  } finally {
    config.CLAMAV_PORT = realPort;
  }
  const audit = await app.db.query<{ action: string }>(
    `SELECT action FROM audit_log WHERE object_id = $1 ORDER BY occurred_at`,
    [id]
  );
  const actions = audit.rows.map((r) => r.action);
  assert.ok(actions.includes('document.uploaded'));
  assert.ok(
    actions.includes('document.scan.skipped'),
    '"we never scanned it" is only provable if the skip left a row'
  );
});

test('dependency health measures a DURATION: since moves only on transition', async () => {
  const { probeDependencies } = await import('../src/modules/admin/container-health.ts');

  await probeDependencies(app); // clamd up
  const first = await app.db.query<{ reachable: boolean; since: string }>(
    `SELECT reachable, since FROM dependency_health WHERE name = 'clamav'`
  );
  assert.equal(first.rows[0]!.reachable, true);

  await probeDependencies(app); // still up — the clock must NOT restart
  const second = await app.db.query<{ since: string }>(
    `SELECT since FROM dependency_health WHERE name = 'clamav'`
  );
  assert.equal(
    new Date(second.rows[0]!.since).getTime(),
    new Date(first.rows[0]!.since).getTime(),
    'an unchanged state keeps its original start time — otherwise "down for 13h" can never be said'
  );

  const realPort = config.CLAMAV_PORT;
  config.CLAMAV_PORT = 1;
  try {
    await probeDependencies(app);
  } finally {
    config.CLAMAV_PORT = realPort;
  }
  const down = await app.db.query<{ reachable: boolean; since: string; detail: string | null }>(
    `SELECT reachable, since, detail FROM dependency_health WHERE name = 'clamav'`
  );
  assert.equal(down.rows[0]!.reachable, false);
  assert.ok(
    new Date(down.rows[0]!.since).getTime() >= new Date(first.rows[0]!.since).getTime(),
    'the clock restarts when the state actually changes'
  );
  assert.ok(down.rows[0]!.detail, 'and it says why, for the dashboard');
});

test('the ops dashboard endpoint reports the backlog, not just a red light', async () => {
  // Any authenticated staffer, deliberately NOT admin-only: a wedged scanner is
  // operational information for whoever is working the queue. Preparer is the
  // least-privileged role that touches documents, so it is the right one to prove it.
  const secret = 'JBSWY3DPEHPK3PXP';
  const staff = await makeStaff(app.db, config, {
    email: 'scanhealth@example.test',
    name: 'Synthetic Preparer',
    role: 'tax_preparer',
    password: 'preparer-password-123456',
    totpSecret: secret,
  });
  const code = new OTPAuth.TOTP({
    algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret),
  }).generate();
  const login = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: staff.email, password: staff.password, totp: code },
  });
  assert.equal(login.statusCode, 200, login.body);
  const token = (login.json() as { token: string }).token;

  const res = await app.inject({
    method: 'GET',
    url: '/admin/system-health',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as {
    dependencies: Array<{ name: string }>;
    documentScans: Array<{ status: string; n: number }>;
  };
  assert.ok(body.dependencies.some((d) => d.name === 'clamav'), 'the scanner is on the dashboard');
  assert.ok(body.documentScans.length > 0, 'and so is the document backlog');
});

test('THE ASSERTION THAT MAKES not_configured SAFE: production refuses to boot without a scanner', async () => {
  // not_configured is allowed through the filing gate so dev and test work at all.
  // That is only defensible because production cannot reach that state. If this
  // assertion is ever removed, one missing line in .env silently files every client
  // document unscanned with a compliance column that says it was fine.
  const { loadConfig } = await import('../src/config.ts');
  const base = {
    NODE_ENV: 'production' as const,
    APP_ENCRYPTION_KEY: 'f'.repeat(64),
    MAIL_TRANSPORT: 'smtp' as const,
    SMTP_HOST: 'smtp.example.test',
    SMTP_USER: 'u',
    SMTP_PASS: 'p',
    WEBHOOK_SECRET: 'not-the-dev-value-either',
    DATABASE_URL: config.DATABASE_URL,
  };

  assert.throws(
    () => loadConfig({ ...base, CLAMAV_HOST: undefined }),
    /CLAMAV_HOST is unset/,
    'no scanner in production must be a boot failure, not a quiet degradation'
  );

  // And with a scanner configured, this particular check passes.
  assert.doesNotThrow(() => loadConfig({ ...base, CLAMAV_HOST: 'clamav' }));
});

test('with no scanner configured at all, filing still works — dev is not broken', async () => {
  const saved = config.CLAMAV_HOST;
  delete (config as { CLAMAV_HOST?: string }).CLAMAV_HOST;
  try {
    const { contactId, cookie } = await portalClient('NoScannerAtAll');
    const itemId = await requestOneItem(contactId);
    const res = await app.inject({
      method: 'POST',
      url: '/portal/documents',
      ...upload(cookie, { category: 'tax_documents', documentRequestItemId: itemId }),
    });
    assert.equal(res.statusCode, 201);
    const { id } = res.json() as { id: string };

    const row = await scanRow(id);
    assert.equal(row.scan_status, 'not_configured', 'recorded honestly — NOT as clean');

    const item = await app.db.query<{ status: string }>(
      `SELECT status::text AS status FROM document_request_items WHERE id = $1`,
      [itemId]
    );
    assert.equal(item.rows[0]!.status, 'received', 'and it files, so local flows are usable');
  } finally {
    config.CLAMAV_HOST = saved;
  }
});

test('FINDING #16: the firm-wide overview leads with what is wrong', async () => {
  // Staff could only ever ask about ONE contact's documents, so "what is quarantined
  // right now?" required already knowing whose file to look at. This endpoint is that
  // question, and the ORDER of its answer is the triage.
  const secret = 'JBSWY3DPEHPK3PXP';
  const staff = await makeStaff(app.db, config, {
    email: 'docsoverview@example.test',
    name: 'Synthetic Preparer Two',
    role: 'tax_preparer',
    password: 'preparer-password-123456',
    totpSecret: secret,
  });
  const code = new OTPAuth.TOTP({
    algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret),
  }).generate();
  const login = await app.inject({
    method: 'POST', url: '/auth/login',
    payload: { email: staff.email, password: staff.password, totp: code },
  });
  assert.equal(login.statusCode, 200, login.body);
  const auth = { authorization: `Bearer ${(login.json() as { token: string }).token}` };

  const res = await app.inject({ method: 'GET', url: '/documents/overview', headers: auth });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as {
    documents: Array<{ scan_status: string; contact_name: string | null; filename: string }>;
    counts: Record<string, number>;
  };

  assert.ok(body.documents.length > 0, 'earlier tests in this file left documents behind');
  assert.ok((body.counts.infected ?? 0) >= 1, 'the infected upload from earlier is counted');

  // Infected must sort ahead of everything, whatever its upload time.
  const firstClean = body.documents.findIndex((d) => d.scan_status === 'clean');
  const lastInfected = body.documents.map((d) => d.scan_status).lastIndexOf('infected');
  if (firstClean !== -1 && lastInfected !== -1) {
    assert.ok(lastInfected < firstClean, 'quarantined files sort above clean ones — the list IS the triage');
  }

  // A filename with no client is not actionable.
  assert.ok(
    body.documents.every((d) => 'contact_name' in d),
    'every row names its client'
  );

  // The deep link from the dashboard must actually filter.
  const quarantine = await app.inject({
    method: 'GET', url: '/documents/overview?scanStatus=infected', headers: auth,
  });
  assert.equal(quarantine.statusCode, 200);
  const q = quarantine.json() as { documents: Array<{ scan_status: string }>; counts: Record<string, number> };
  assert.ok(q.documents.length > 0);
  assert.ok(q.documents.every((d) => d.scan_status === 'infected'), 'filtered to quarantine only');
  assert.ok(
    (q.counts.clean ?? 0) >= 1,
    'counts stay UNFILTERED so the chips still show the rest while you are looking at quarantine'
  );

  // Firm-wide listing is audited like every other document access.
  const audit = await app.db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM audit_log
      WHERE action = 'documents.listed' AND details->>'scope' = 'firm_wide'`
  );
  assert.ok(audit.rows[0]!.n >= 2, 'both listings left an audit row');
});

test('PORTAL-UPLOAD ACK: one receipt per session, not per file, and never the portal-nudge copy', async () => {
  verdict = 'clean';
  const { contactId, cookie } = await portalClient('AckThrottle');

  // createTestConfig arms every automation, so the ack is live here.
  const first = await app.inject({
    method: 'POST', url: '/portal/documents', ...upload(cookie, { category: 'tax_documents' }),
  });
  assert.equal(first.statusCode, 201);

  const sentAfterOne = await app.db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM audit_log WHERE action = 'document.ack_sent' AND contact_id = $1`,
    [contactId]
  );
  assert.equal(sentAfterOne.rows[0]!.n, 1, 'the first upload is acknowledged');

  // Second upload in the same window: suppressed, and the suppression is COUNTED.
  const second = await app.inject({
    method: 'POST', url: '/portal/documents', ...upload(cookie, { category: 'business_records' }),
  });
  assert.equal(second.statusCode, 201, 'the upload still succeeds');

  const after = await app.db.query<{ action: string; reason: string | null }>(
    `SELECT action, details->>'reason' AS reason FROM audit_log
      WHERE action IN ('document.ack_sent', 'document.ack_suppressed') AND contact_id = $1
      ORDER BY occurred_at`,
    [contactId]
  );
  assert.equal(after.rows.filter((r) => r.action === 'document.ack_sent').length, 1,
    'ten files in one sitting is one receipt, not ten');
  assert.equal(after.rows.at(-1)!.action, 'document.ack_suppressed');
  assert.equal(after.rows.at(-1)!.reason, 'throttled', 'and the suppression says why');

  // Brian's copy rule: no "use the portal" nudge to someone already in the portal.
  const tpl = await app.db.query<{ body_en: string; body_es: string; subject_en: string }>(
    `SELECT body_en, body_es, subject_en FROM templates WHERE key = 'portal_upload_received_email'`
  );
  const t = tpl.rows[0]!;
  assert.ok(t, 'the ack has its OWN template, not the inbound one');
  for (const body of [t.body_en, t.body_es]) {
    assert.doesNotMatch(body, /\{\{portal_link\}\}/, 'no portal link — they are already in it');
    assert.doesNotMatch(body, /secure portal|portal seguro/i, 'and no portal nudge copy');
  }
  assert.match(t.body_en, /What happens next/, 'it says what happens next, per the ruling');
  assert.match(t.body_es, /Qué sigue/, 'in Spanish too');
});

test('an infected upload is never acknowledged — that conversation is Brian’s', async () => {
  verdict = 'infected';
  const { contactId, cookie } = await portalClient('AckInfected');
  const res = await app.inject({
    method: 'POST', url: '/portal/documents', ...upload(cookie, { category: 'tax_documents' }),
  });
  assert.equal(res.statusCode, 201, 'still accepted');

  const acks = await app.db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM audit_log WHERE action = 'document.ack_sent' AND contact_id = $1`,
    [contactId]
  );
  assert.equal(acks.rows[0]!.n, 0, 'no cheerful receipt for a quarantined file');
  verdict = 'clean';
});

test('with the automation OFF the upload still works and the suppression is recorded', async () => {
  verdict = 'clean';
  await app.db.query(`UPDATE automations SET enabled = false WHERE key = 'portal_upload_acks'`);
  try {
    const { contactId, cookie } = await portalClient('AckDisarmed');
    const res = await app.inject({
      method: 'POST', url: '/portal/documents', ...upload(cookie, { category: 'tax_documents' }),
    });
    assert.equal(res.statusCode, 201, 'the file is still accepted, scanned and filed');

    const rows = await app.db.query<{ reason: string | null }>(
      `SELECT details->>'reason' AS reason FROM audit_log
        WHERE action = 'document.ack_suppressed' AND contact_id = $1`,
      [contactId]
    );
    assert.equal(rows.rowCount, 1);
    assert.equal(rows.rows[0]!.reason, 'automation_disabled',
      'every suppression is counted — arming it must be a decision with visible consequences');
  } finally {
    await app.db.query(`UPDATE automations SET enabled = true WHERE key = 'portal_upload_acks'`);
  }
});
