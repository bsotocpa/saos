// M27 "Prove it": the SOP knowledge base.
//
// CLAUDE.md: "task types carry an optional 'how to do this' link into the
// knowledge base; building a task-generating feature without its SOP hook is
// incomplete." The build-time half of that is scripts/check-task-sop-hooks.mjs
// (wired into npm test). This spec covers the runtime half:
//
//   · a generated task carries its SOP link WITHOUT anyone pasting a URL
//   · an unwritten SOP resolves to null, never a dead link
//   · search returns PUBLISHED only — a draft is an unreviewed transcript, and
//     surfacing it beside approved procedure would make the KB untrustworthy
//   · publishing snapshots the outgoing body, so "what did this say in March" is
//     answerable
//   · a Whisper-seeded draft is labelled as a transcript and needs approval

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import type { Mailer } from '../src/mailer.ts';
import { createTestConfig, makeContact, makeStaff, type TestStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';
import { createTask } from '../src/modules/tasks/service.ts';
import { TASK_TYPE_SOPS } from '../src/modules/sops/task-types.ts';
import { taskTypeSopRegistry } from '../src/modules/sops/service.ts';

let app: FastifyInstance;
let config: Config;
let brian: TestStaff & { token: string };
let ana: TestStaff & { token: string };

const silentMailer: Mailer = { transport: 'console', async send() { return { id: 'silent' }; } };
const auth = (t: { token: string }) => ({ authorization: `Bearer ${t.token}` });

async function staffWithToken(email: string, role: string): Promise<TestStaff & { token: string }> {
  const secret = new OTPAuth.Secret({ size: 20 }).base32;
  const staff = await makeStaff(app.db, config, {
    email, name: `Synthetic ${role}`, role, password: `${role}-password-1234567`, totpSecret: secret,
  });
  const code = new OTPAuth.TOTP({
    algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret),
  }).generate();
  const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: staff.password, totp: code } });
  assert.equal(res.statusCode, 200, res.body);
  return { ...staff, token: res.json().token as string };
}

before(async () => {
  config = await createTestConfig('sops');
  app = buildServer(config, { mailer: silentMailer });
  await app.ready();
  brian = await staffWithToken('brian-sop@example.test', 'ceo');
  ana = await staffWithToken('ana-sop@example.test', 'tax_preparer');
});

after(async () => {
  await app.close();
});

test('every task type in the registry has an SOP or a written reason for having none', async () => {
  // The build-time checker proves the registry COVERS the code; this proves each
  // entry is a real decision rather than an empty slot.
  for (const [taskType, entry] of Object.entries(TASK_TYPE_SOPS)) {
    if (entry.sop === null) {
      assert.ok(
        (entry.reason ?? '').trim().length >= 20,
        `${taskType}: sop:null needs a real reason, got "${entry.reason ?? ''}"`
      );
    } else {
      assert.match(entry.sop, /^[a-z0-9]+(-[a-z0-9]+)*$/, `${taskType}: SOP slug should be kebab-case`);
    }
  }

  const registry = await taskTypeSopRegistry(app);
  assert.equal(registry.total, Object.keys(TASK_TYPE_SOPS).length);
  // The seeded skeletons cover every mapping — nothing points at a missing SOP.
  assert.equal(registry.mappedButUnwritten, 0, 'a mapping pointing at an unwritten SOP would be a dead link');
  assert.ok(registry.published >= 20, 'the seeded skeletons are published');
  assert.ok(registry.deliberatelyNone >= 1, 'and some task types genuinely need no procedure');
});

test('a generated task carries its SOP link with nobody pasting a URL', async () => {
  const c = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Sopped', email: 'sopped@example.test' });

  // irs_notice maps to ana-notice-playbook, which the seed published.
  const withSop = await createTask(app, {
    title: 'Synthetic notice to action',
    contactId: c.id,
    source: 'automation',
    sourceType: 'irs_notice',
    sourceId: 'synthetic-notice-1',
  });
  const linked = await app.db.query<{ sop_link: string | null }>(
    `SELECT sop_link FROM tasks WHERE id = $1`, [withSop.id]
  );
  assert.equal(linked.rows[0]!.sop_link, '/sops/ana-notice-playbook');

  // A task type deliberately mapped to no SOP gets no link — and no fake one.
  const noSop = await createTask(app, {
    title: 'Synthetic backup alert',
    source: 'automation',
    sourceType: 'backup_stale',
    sourceId: 'synthetic-backup-1',
  });
  const unlinked = await app.db.query<{ sop_link: string | null }>(
    `SELECT sop_link FROM tasks WHERE id = $1`, [noSop.id]
  );
  assert.equal(unlinked.rows[0]!.sop_link, null);

  // An explicit link from the caller always wins over the registry.
  const explicit = await createTask(app, {
    title: 'Synthetic with its own link',
    source: 'manual',
    sourceType: 'irs_notice',
    sourceId: 'synthetic-notice-2',
    sopLink: '/sops/something-specific',
  });
  const kept = await app.db.query<{ sop_link: string }>(`SELECT sop_link FROM tasks WHERE id = $1`, [explicit.id]);
  assert.equal(kept.rows[0]!.sop_link, '/sops/something-specific');
});

test('a mapping pointing at a DRAFT or missing SOP resolves to null, not a dead link', async () => {
  // Unpublish the notice playbook: a new hire must not be sent to a draft.
  await app.db.query(`UPDATE sops SET status = 'draft' WHERE slug = 'ana-notice-playbook'`);
  const drafted = await createTask(app, {
    title: 'Synthetic notice while the SOP is a draft',
    source: 'automation',
    sourceType: 'irs_notice',
    sourceId: 'synthetic-notice-3',
  });
  const row = await app.db.query<{ sop_link: string | null }>(`SELECT sop_link FROM tasks WHERE id = $1`, [drafted.id]);
  assert.equal(row.rows[0]!.sop_link, null, 'a draft SOP is not a link you send a new hire to');

  // And the registry reports it honestly rather than claiming coverage.
  const registry = await taskTypeSopRegistry(app);
  const entry = registry.entries.find((e) => e.taskType === 'irs_notice')!;
  assert.equal(entry.written, true);
  assert.equal(entry.published, false, 'written but not published is its own state');

  await app.db.query(
    `UPDATE sops SET status = 'published' WHERE slug = 'ana-notice-playbook'`
  );
});

test('search returns published SOPs only, and any staffer can read them', async () => {
  // A new hire — no leadership permission — must be able to find procedure.
  const found = await app.inject({ method: 'GET', url: '/sops?q=escalation+call', headers: auth(ana) });
  assert.equal(found.statusCode, 200, found.body);
  const slugs = found.json().sops.map((s: { slug: string }) => s.slug);
  assert.ok(slugs.includes('rene-escalation-call'), `expected the escalation SOP, got ${slugs.join(', ')}`);

  // Full-text search actually searches the body, not just titles.
  const byBody = await app.inject({ method: 'GET', url: '/sops?q=perfection+period', headers: auth(ana) });
  assert.ok(
    byBody.json().sops.some((s: { slug: string }) => s.slug === 'ana-efile-reject'),
    'body text is searchable'
  );

  // A draft is invisible in search even to its author's colleagues.
  await app.inject({
    method: 'POST', url: '/sops', headers: auth(brian),
    payload: {
      slug: 'synthetic-secret-draft', title: 'Synthetic unreviewed handoff notes',
      bodyMd: 'Some half-remembered process nobody has checked, mentioning zzzunique.',
    },
  });
  const draftSearch = await app.inject({ method: 'GET', url: '/sops?q=zzzunique', headers: auth(ana) });
  assert.equal(draftSearch.json().sops.length, 0, 'drafts never appear beside approved procedure');

  // Even asking for drafts does not help a non-author.
  const anaAsks = await app.inject({ method: 'GET', url: '/sops?q=zzzunique&includeDrafts=true', headers: auth(ana) });
  assert.equal(anaAsks.json().sops.length, 0);

  // Brian, who writes them, can see his own drafts.
  const brianAsks = await app.inject({ method: 'GET', url: '/sops?q=zzzunique&includeDrafts=true', headers: auth(brian) });
  assert.equal(brianAsks.json().sops.length, 1);
  assert.equal(brianAsks.json().sops[0].status, 'draft');
});

test('publishing snapshots the outgoing body, so history is answerable', async () => {
  await app.inject({
    method: 'POST', url: '/sops', headers: auth(brian),
    payload: {
      slug: 'synthetic-versioned', title: 'Synthetic versioned procedure', roleKey: 'bookkeeper',
      bodyMd: 'Step one: do the first thing carefully and completely before moving on.',
    },
  });

  // Too thin to be followable is refused rather than published as a stub.
  await app.inject({
    method: 'PATCH', url: '/sops/synthetic-versioned', headers: auth(brian),
    payload: { bodyMd: 'Do it.' },
  });
  const thin = await app.inject({ method: 'POST', url: '/sops/synthetic-versioned/publish', headers: auth(brian) });
  assert.equal(thin.statusCode, 400, thin.body);
  assert.equal(thin.json().error, 'too_thin_to_publish');

  await app.inject({
    method: 'PATCH', url: '/sops/synthetic-versioned', headers: auth(brian),
    payload: { bodyMd: 'Version one: reconcile every account before closing the period, without exception.' },
  });
  const first = await app.inject({
    method: 'POST', url: '/sops/synthetic-versioned/publish', headers: auth(brian),
    payload: { note: 'First published version.' },
  });
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json().version, 1);

  // Edit and republish → version 2, with version 1's text preserved.
  await app.inject({
    method: 'PATCH', url: '/sops/synthetic-versioned', headers: auth(brian),
    payload: { bodyMd: 'Version two: reconcile, then have a second person spot-check the reconciliation.' },
  });
  const second = await app.inject({
    method: 'POST', url: '/sops/synthetic-versioned/publish', headers: auth(brian),
    payload: { note: 'Added the second-person check after the March mistake.' },
  });
  assert.equal(second.json().version, 2);

  const view = await app.inject({ method: 'GET', url: '/sops/synthetic-versioned', headers: auth(ana) });
  assert.equal(view.json().sop.version, 2);
  assert.match(view.json().sop.body_md, /second person spot-check/);
  assert.ok(view.json().sop.published_by, 'a human-published SOP names its approver');
  const history = view.json().history;
  assert.ok(history.length >= 1);
  assert.match(history[0].note, /second-person check/);

  // The superseded text is still retrievable — that is the point of versioning.
  const v1 = await app.db.query<{ body_md: string }>(
    `SELECT v.body_md FROM sop_versions v JOIN sops s ON s.id = v.sop_id
     WHERE s.slug = 'synthetic-versioned' AND v.version = 1`
  );
  assert.match(v1.rows[0]!.body_md, /Version one/, 'what it said before is still on record');
});

test('writing is leadership; reading is not', async () => {
  const refused = await app.inject({
    method: 'POST', url: '/sops', headers: auth(ana),
    payload: { slug: 'synthetic-ana-writes', title: 'Synthetic', bodyMd: 'Anything at all here.' },
  });
  assert.equal(refused.statusCode, 403, 'a preparer does not rewrite firm procedure');

  const publish = await app.inject({
    method: 'POST', url: '/sops/marian-month-end-close/publish', headers: auth(ana),
  });
  assert.equal(publish.statusCode, 403);

  const read = await app.inject({ method: 'GET', url: '/sops/marian-month-end-close', headers: auth(ana) });
  assert.equal(read.statusCode, 200, 'but she can absolutely read it');
  assert.match(read.json().sop.body_md, /Reconcile/i);
});

test('a Whisper-seeded SOP is a labelled DRAFT, never auto-published', async () => {
  const c = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Handoff', email: 'handoff-sop@example.test' });
  const meeting = await app.db.query<{ id: string }>(
    `INSERT INTO meetings (contact_id, title, type, source, status)
     VALUES ($1, 'Synthetic handoff session', 'zoom', 'voice_memo_upload', 'ready') RETURNING id`,
    [c.id]
  );
  await app.db.query(
    `INSERT INTO transcripts (meeting_id, engine, content) VALUES ($1, 'whisper', $2)`,
    [
      meeting.rows[0]!.id,
      'So the way I do the close is, first I categorize everything, then I reconcile, ' +
        'and I always check the bank feed twice.',
    ]
  );

  const seeded = await app.inject({
    method: 'POST', url: `/meetings/${meeting.rows[0]!.id}/seed-sop`, headers: auth(brian),
    payload: { slug: 'synthetic-from-transcript', title: 'Close process (from handoff)', roleKey: 'bookkeeper' },
  });
  assert.equal(seeded.statusCode, 201, seeded.body);
  assert.equal(seeded.json().status, 'draft', 'a transcript is a starting point, not a procedure');

  const view = await app.inject({ method: 'GET', url: '/sops/synthetic-from-transcript', headers: auth(brian) });
  assert.equal(view.json().sop.from_transcript, true, 'provenance is permanent');
  assert.match(view.json().sop.body_md, /Draft seeded from a recorded session/);
  assert.match(view.json().sop.body_md, /check the bank feed twice/, 'the actual words are carried through');

  // Invisible to a searching colleague until someone approves it.
  const search = await app.inject({ method: 'GET', url: '/sops?q=bank+feed', headers: auth(ana) });
  /*
   * The RULE is "a draft is invisible to a searching colleague". This asserted an EMPTY result
   * set, which was a proxy that held only while no published SOP happened to match — and stopped
   * holding the day `laura-sos-verify` shipped saying an adverse standing is better found by us
   * "than by a client discovering it at a bank". A published page matching a search is correct
   * behaviour; the draft appearing would not be.
   */
  const slugs = (search.json().sops as Array<{ slug: string }>).map((x) => x.slug);
  assert.ok(!slugs.includes('synthetic-from-transcript'), 'the DRAFT stays invisible');

  // A recording with nothing transcribed yet cannot seed anything.
  const empty = await app.db.query<{ id: string }>(
    `INSERT INTO meetings (contact_id, title, type, source, status) VALUES ($1, 'Synthetic unprocessed', 'zoom', 'voice_memo_upload', 'recorded') RETURNING id`,
    [c.id]
  );
  const nothing = await app.inject({
    method: 'POST', url: `/meetings/${empty.rows[0]!.id}/seed-sop`, headers: auth(brian),
    payload: { slug: 'synthetic-nothing', title: 'Nothing yet' },
  });
  assert.equal(nothing.statusCode, 409);
  assert.equal(nothing.json().error, 'nothing_to_seed');
});

test('the seeded skeletons are honest about being skeletons', async () => {
  const { rows } = await app.db.query<{ slug: string; body_md: string }>(
    `SELECT slug, body_md FROM sops WHERE slug LIKE 'rene-%' OR slug LIKE 'ana-%' OR slug LIKE 'marian-%'`
  );
  assert.ok(rows.length >= 10);
  for (const r of rows) {
    assert.match(
      r.body_md,
      /Skeleton/,
      `${r.slug} should say plainly that it is a skeleton awaiting Brian's judgement calls`
    );
  }
});

test('seeded skeletons publish UNREVIEWED, and say so rather than borrowing Brian’s name', async () => {
  // The honest state: these links work on day one, but nobody has approved the
  // content. Attributing them to Brian at seed time would put his name on
  // procedure he never wrote.
  const { rows } = await app.db.query<{ slug: string; published_by_staff_id: string | null; status: string }>(
    `SELECT slug, published_by_staff_id, status::text FROM sops WHERE slug = 'marian-month-end-close'`
  );
  assert.equal(rows[0]!.status, 'published', 'published so the task links resolve');
  assert.equal(rows[0]!.published_by_staff_id, null, 'but with no human approver claimed');

  const view = await app.inject({ method: 'GET', url: '/sops/marian-month-end-close', headers: auth(ana) });
  assert.equal(view.json().sop.published_by, null, 'the UI can show "not yet reviewed by a person"');
  assert.match(view.json().sop.body_md, /Skeleton/);
});
