// R102 (Brian, 2026-09-30): returns with no preparer are visible. The executive view counts the open
// returns naming no preparer, the count opens the list, and two business days after a return opened
// with no preparer the CEO is alerted once through the R90 internal ladder. One predicate for all
// three (NO_PREPARER_SQL): withdrawn and completed returns are not open, and a test client is left out.
// Synthetic data only.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import { createTestConfig, makeStaff, type TestStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';
import { runInternalTaskLadderJob } from '../src/modules/tasks/service.ts';

let app: FastifyInstance;
let config: Config;
let brian: TestStaff & { token: string };
let ana: TestStaff & { token: string };
const auth = (t: { token: string }) => ({ authorization: `Bearer ${t.token}` });

async function staffWithToken(email: string, role: string): Promise<TestStaff & { token: string }> {
  const secret = new OTPAuth.Secret({ size: 20 }).base32;
  const staff = await makeStaff(app.db, config, { email, name: `Synthetic ${role}`, role, password: `${role}-password-123456`, totpSecret: secret });
  const code = new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) }).generate();
  const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: staff.password, totp: code } });
  assert.equal(res.statusCode, 200, res.body);
  return { ...staff, token: res.json().token as string };
}

/** A return opened on `openedOn` (a Chicago day, noon), at `stage`, with or without a preparer. */
async function openReturn(last: string, opts: { openedOn: string; stage?: string; preparerId?: string | null; isTest?: boolean }): Promise<string> {
  const c = await app.db.query<{ id: string }>(
    `INSERT INTO contacts (first_name, last_name, email, is_test, test_note) VALUES ('Synthetic', $1, $2, $3, $4) RETURNING id`,
    [last, `${last.toLowerCase()}@example.test`, opts.isTest ?? false, opts.isTest ? 'Synthetic test record for the R102 spec.' : null]
  );
  const stage = opts.stage ?? 'intake_started';
  const status = stage === 'withdrawn' ? 'withdrawn' : stage === 'completed' ? 'completed' : 'active';
  const e = await app.db.query<{ id: string }>(
    `INSERT INTO engagements (contact_id, service_line, status, ended_on, close_reason)
     VALUES ($1, 'tax', $2::engagement_status, CASE WHEN $2 IN ('completed', 'withdrawn') THEN $3::date END,
             CASE WHEN $2 = 'withdrawn' THEN 'Synthetic: withdrawn for the R102 spec.' END) RETURNING id`,
    [c.rows[0]!.id, status, opts.openedOn]
  );
  const te = await app.db.query<{ id: string }>(
    `INSERT INTO tax_engagements (engagement_id, tax_year, return_type, stage, preparer_id, original_deadline, created_at)
     VALUES ($1, 2025, '1040', $2::tax_stage, $3, '2026-10-15', ($4::date + time '12:00') AT TIME ZONE 'America/Chicago')
     RETURNING id`,
    [e.rows[0]!.id, stage, opts.preparerId ?? null, opts.openedOn]
  );
  return te.rows[0]!.id;
}

let unassignedMonday = '';
let unassignedFriday = '';

before(async () => {
  config = await createTestConfig('nopreparer');
  app = buildServer(config);
  await app.ready();
  brian = await staffWithToken('brian-noprep@example.test', 'ceo');
  ana = await staffWithToken('ana-noprep@example.test', 'tax_preparer');
  // 2026-09-28 is a Monday; 2026-09-25 a Friday.
  unassignedMonday = await openReturn('Noprepmonday', { openedOn: '2026-09-28' });
  unassignedFriday = await openReturn('Noprepfriday', { openedOn: '2026-09-25' });
  await openReturn('Noprepassigned', { openedOn: '2026-09-21', preparerId: ana.id });
  await openReturn('Noprepwithdrawn', { openedOn: '2026-08-13', stage: 'withdrawn' });
  await openReturn('Noprepcompleted', { openedOn: '2026-08-13', stage: 'completed' });
  await openReturn('Noprepflagged', { openedOn: '2026-09-01', isTest: true });
});

after(async () => { await app.close(); });

test('the executive count and the list it opens are the same returns: open, no preparer, not a test client', async () => {
  const exec = await app.inject({ method: 'GET', url: '/dashboards/executive', headers: auth(brian) });
  assert.equal(exec.statusCode, 200, exec.body);
  assert.equal(exec.json().returnsWithNoPreparer.count, 2, 'withdrawn, completed, assigned and test-client returns are not counted');
  const list = await app.inject({ method: 'GET', url: '/dashboards/open-returns?preparer=none', headers: auth(brian) });
  assert.equal(list.statusCode, 200, list.body);
  const ids = (list.json().returns as Array<{ id: string; preparer_id: string | null }>).map((r) => r.id).sort();
  assert.deepEqual(ids, [unassignedMonday, unassignedFriday].sort(), 'the list is exactly the counted returns');
  const stageList = await app.inject({ method: 'GET', url: '/dashboards/open-returns?stage=intake_started', headers: auth(brian) });
  assert.equal(stageList.statusCode, 200, 'the stage list still answers');
  const refused = await app.inject({ method: 'GET', url: '/dashboards/open-returns?preparer=none', headers: auth(ana) });
  assert.equal(refused.statusCode, 403, 'the same grant as the executive view');
});

test('two business days after it opened with no preparer, the CEO is alerted once; a weekend does not count', async () => {
  const alerts = async () => (await app.db.query<{ related_object_id: string; title: string }>(
    `SELECT related_object_id, title FROM notifications WHERE type = 'return_no_preparer' AND staff_id = $1`, [brian.id])).rows;

  // Tuesday 09-29: Monday's return is one business day old; Friday's is one too (the weekend is not counted).
  let run = await runInternalTaskLadderJob(app, '2026-09-29');
  assert.equal(run.noPreparerConsidered, 2);
  assert.equal(run.noPreparerAlerted, 1, "only Friday's return has two business days (Mon, Tue)");
  assert.deepEqual((await alerts()).map((a) => a.related_object_id), [unassignedFriday]);

  // Wednesday 09-30: Monday's return reaches two business days.
  run = await runInternalTaskLadderJob(app, '2026-09-30');
  assert.equal(run.noPreparerAlerted, 1, "Monday's return alerts; Friday's never alerts twice");
  const all = await alerts();
  assert.equal(all.length, 2, 'one alert per return');
  assert.match(all.find((a) => a.related_object_id === unassignedMonday)!.title, /^2 business days with no preparer: 2025 1040 for Synthetic Noprepmonday$/);

  // Assigned, a return leaves the count and alerts no more.
  await app.db.query(`UPDATE tax_engagements SET preparer_id = $2 WHERE id = $1`, [unassignedMonday, ana.id]);
  const exec = await app.inject({ method: 'GET', url: '/dashboards/executive', headers: auth(brian) });
  assert.equal(exec.json().returnsWithNoPreparer.count, 1);
  run = await runInternalTaskLadderJob(app, '2026-10-01');
  assert.equal(run.noPreparerConsidered, 1);
  assert.equal(run.noPreparerAlerted, 0);
});
