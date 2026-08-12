// Attachments in Messages (finding #11) — a portal upload that happens to start in
// chat.
//
// Brian's requirement is the whole point of this suite: a Messages-originated file
// must stamp IDENTICAL provenance and filing metadata to a direct portal upload, so
// downstream filing, chase and Documents logic cannot distinguish the source. No
// silent fork in the pipeline.
//
// The strongest form of that test is a differential one: upload the same bytes both
// ways and assert the document rows are equal on every column that is not an
// identity or a timestamp. If someone later adds a source flag to documents, this
// fails.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import type { Mailer } from '../src/mailer.ts';
import { createTestConfig, makeContact, multipartBody } from './helpers.ts';
import type { Config } from '../src/config.ts';

let app: FastifyInstance;
let config: Config;

const silentMailer: Mailer = { transport: 'console', async send() { return { id: 'silent' }; } };

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
  return { contactId: c.id, email, cookie: { cookie: `saos_portal_session=${token}` } };
}

const FILE_BYTES = Buffer.from('%PDF-1.4 synthetic W-2\n%%EOF');

/**
 * multipartBody() returns its own headers, so spreading it AFTER a cookie header
 * silently replaces the session and every request 401s — which is exactly what
 * happened on the first run of this suite. Merge the two deliberately.
 */
function upload(
  cookie: { cookie: string } | null,
  fields: Record<string, string>,
  file?: { filename: string; contentType: string; data: Buffer }
): { payload: Buffer; headers: Record<string, string> } {
  const mp = multipartBody(fields, {
    field: 'file',
    filename: file?.filename ?? 'w2.pdf',
    contentType: file?.contentType ?? 'application/pdf',
    data: file?.data ?? FILE_BYTES,
  });
  return { payload: mp.payload, headers: { ...mp.headers, ...(cookie ?? {}) } };
}

before(async () => {
  config = await createTestConfig('msgattach');
  app = buildServer(config, { mailer: silentMailer });
  await app.ready();
});

after(async () => {
  await app.close();
});

test('THE REQUIREMENT: a Messages file is indistinguishable from a direct upload', async () => {
  const { contactId, cookie } = await portalClient('SameProvenance');

  const direct = await app.inject({
    method: 'POST', url: '/portal/documents', ...upload(cookie, { category: 'tax_documents' }),
  });
  assert.equal(direct.statusCode, 201, direct.body);

  const viaChat = await app.inject({
    method: 'POST', url: '/portal/messages/attachments', ...upload(cookie, { category: 'tax_documents' }),
  });
  assert.equal(viaChat.statusCode, 201, viaChat.body);

  // Compare every column that is not an identity or a timestamp.
  const rows = await app.db.query<Record<string, unknown>>(
    `SELECT id, contact_id, category::text AS category, filename, mime_type,
            size_bytes, sha256, minio_bucket, status::text AS status,
            uploaded_by_type::text AS uploaded_by_type, uploaded_by_id, tax_year
     FROM documents WHERE contact_id = $1 ORDER BY created_at`,
    [contactId]
  );
  assert.equal(rows.rows.length, 2, 'both uploads produced a document');
  const [a, b] = rows.rows as [Record<string, unknown>, Record<string, unknown>];

  for (const key of Object.keys(a)) {
    if (key === 'id') continue; // identity differs by definition
    assert.deepEqual(
      b[key], a[key],
      `documents.${key} differs between a direct upload and a Messages upload — that is a fork in the pipeline`
    );
  }

  // And nothing on the document points back at chat: the linkage is one-way.
  const cols = await app.db.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'documents'`
  );
  const names = cols.rows.map((r) => r.column_name);
  for (const forbidden of ['source', 'origin', 'message_id', 'thread_id', 'via']) {
    assert.ok(
      !names.includes(forbidden),
      `documents.${forbidden} exists — downstream logic could branch on upload source`
    );
  }
});

test('the message keeps IMMUTABLE TEXT plus a reference (Brian’s ruling)', async () => {
  const { contactId, cookie } = await portalClient('ImmutableText');
  const res = await app.inject({
    method: 'POST', url: '/portal/messages/attachments', ...upload(cookie, { category: 'business_records', note: 'Here is the receipt you asked for.' },
      { filename: 'receipt.pdf', contentType: 'application/pdf', data: FILE_BYTES }),
  });
  assert.equal(res.statusCode, 201, res.body);
  const { documentId } = res.json() as { documentId: string };

  const msg = await app.db.query<{ body: string; document_id: string | null; sender_type: string; channel: string }>(
    `SELECT m.body, m.document_id, m.sender_type::text AS sender_type, m.channel::text AS channel
     FROM messages m JOIN message_threads t ON t.id = m.thread_id WHERE t.contact_id = $1`,
    [contactId]
  );
  assert.equal(msg.rows.length, 1, 'one message, not one for the note and one for the file');
  assert.match(msg.rows[0]!.body, /Here is the receipt you asked for\./, 'the typed note is kept');
  assert.match(msg.rows[0]!.body, /\[Attached: receipt\.pdf\]/, 'and the sentence names the file');
  assert.equal(msg.rows[0]!.document_id, documentId);
  assert.equal(msg.rows[0]!.sender_type, 'client');
  assert.equal(msg.rows[0]!.channel, 'portal');

  // DELETING the document must degrade the link, not punch a hole in the thread.
  await app.db.query(`DELETE FROM documents WHERE id = $1`, [documentId]);
  const after = await app.db.query<{ body: string; document_id: string | null }>(
    `SELECT m.body, m.document_id FROM messages m JOIN message_threads t ON t.id = m.thread_id
     WHERE t.contact_id = $1`,
    [contactId]
  );
  assert.equal(after.rows.length, 1, 'the message still exists');
  assert.equal(after.rows[0]!.document_id, null, 'the reference cleared (ON DELETE SET NULL)');
  assert.match(
    after.rows[0]!.body, /\[Attached: receipt\.pdf\]/,
    'the sentence survives — the conversation still reads correctly'
  );
});

test('it lands in Documents and satisfies a document request like any upload', async () => {
  const { contactId, cookie } = await portalClient('FulfillsRequest');
  const req = await app.db.query<{ id: string }>(
    `INSERT INTO document_requests (contact_id, title_en) VALUES ($1, 'Send your W-2') RETURNING id`,
    [contactId]
  );
  const item = await app.db.query<{ id: string }>(
    `INSERT INTO document_request_items (request_id, label_en)
     VALUES ($1, 'W-2') RETURNING id`,
    [req.rows[0]!.id]
  );

  const res = await app.inject({
    method: 'POST', url: '/portal/messages/attachments', ...upload(cookie, { category: 'tax_documents', documentRequestItemId: item.rows[0]!.id }),
  });
  assert.equal(res.statusCode, 201, res.body);

  // The request item is fulfilled by a file sent in chat, exactly as by a direct
  // upload — this is the chase logic being unable to tell the difference.
  const fulfilled = await app.db.query<{ status: string }>(
    `SELECT status::text AS status FROM document_request_items WHERE id = $1`,
    [item.rows[0]!.id]
  );
  assert.notEqual(fulfilled.rows[0]!.status, 'pending', 'the request item advanced');

  // And the file is visible on the Documents surface.
  const docs = await app.inject({ method: 'GET', url: '/portal/documents', headers: cookie });
  assert.equal(docs.statusCode, 200, docs.body);
  const list = docs.json() as { documents: Array<{ filename: string }> };
  assert.ok(
    list.documents.some((d) => d.filename === 'w2.pdf'),
    'a file sent in chat appears in Documents'
  );
});

test('scoping and validation hold: session contact only, real category, a file required', async () => {
  const mine = await portalClient('ScopedMine');
  const other = await portalClient('ScopedOther');

  // No file part at all — hand-built, because upload() always attaches one.
  const boundary = '----saosNoFilePart';
  const fieldsOnly = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="category"\r\n\r\ntax_documents\r\n--${boundary}--\r\n`
  );
  const noFile = await app.inject({
    method: 'POST',
    url: '/portal/messages/attachments',
    payload: fieldsOnly,
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, ...mine.cookie },
  });
  assert.equal(noFile.statusCode, 400, 'a file is required — this route exists to carry one');

  // A category the client is not allowed to file into.
  const badCat = await app.inject({
    method: 'POST', url: '/portal/messages/attachments', ...upload(mine.cookie, { category: 'signed_authorizations' }, { filename: 'x.pdf', contentType: 'application/pdf', data: FILE_BYTES }),
  });
  assert.equal(badCat.statusCode, 400, 'clients cannot file into staff-only categories');

  // Someone else's thread.
  const theirThread = await app.db.query<{ id: string }>(
    `INSERT INTO message_threads (contact_id, subject) VALUES ($1, 'Theirs') RETURNING id`,
    [other.contactId]
  );
  const crossed = await app.inject({
    method: 'POST', url: '/portal/messages/attachments', ...upload(mine.cookie, { category: 'tax_documents', threadId: theirThread.rows[0]!.id }),
  });
  assert.equal(crossed.statusCode, 404, 'a thread you do not own does not exist to you');

  const anon = await app.inject({
    method: 'POST', url: '/portal/messages/attachments',
    ...upload(null, { category: 'tax_documents' }),
  });
  assert.equal(anon.statusCode, 401);
});
