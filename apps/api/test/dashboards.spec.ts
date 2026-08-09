// M19 "Prove it" (API half): Executive + Hilo dashboards over seeded demo
// data — every figure traced to rows created here; leadership-only RBAC;
// Alert Center endpoints; push sweep semantics (warning/critical to
// leadership only, stamped once). The live ntfy round-trip + the dashboard
// UI run in the dev environment (recorded in the todo review). Synthetic
// data only.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import { createTestConfig, makeStaff, type TestStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';

let app: FastifyInstance;
let config: Config;
let brian: TestStaff & { token: string };
let jackson: TestStaff & { token: string };
let ana: TestStaff & { token: string };

const auth = (t: { token: string }) => ({ authorization: `Bearer ${t.token}` });

async function staffWithToken(email: string, role: string): Promise<TestStaff & { token: string }> {
  const secret = new OTPAuth.Secret({ size: 20 }).base32;
  const staff = await makeStaff(app.db, config, {
    email, name: `Synthetic ${role}`, role, password: `${role}-password-123456`, totpSecret: secret,
  });
  const code = new OTPAuth.TOTP({
    algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret),
  }).generate();
  const res = await app.inject({
    method: 'POST', url: '/auth/login',
    payload: { email, password: staff.password, totp: code },
  });
  assert.equal(res.statusCode, 200, res.body);
  return { ...staff, token: res.json().token as string };
}

before(async () => {
  config = await createTestConfig('dash');
  app = buildServer(config);
  await app.ready();
  brian = await staffWithToken('brian-dash@example.test', 'ceo');
  jackson = await staffWithToken('jackson-dash@example.test', 'ed_coo');
  ana = await staffWithToken('ana-dash@example.test', 'tax_preparer');

  // ── Scenario data ─────────────────────────────────────────────────────────
  // Soto clients with health scores across the bands.
  const mkContact = async (last: string, email: string, extra: string, params: unknown[]) => {
    const { rows } = await app.db.query<{ id: string }>(
      `INSERT INTO contacts (first_name, last_name, email, soto_status ${extra ? ',' + extra : ''})
       VALUES ('Synthetic', $1, $2, 'active' ${extra ? ',' + params.map((_, i) => `$${i + 3}`).join(',') : ''})
       RETURNING id`,
      [last, email, ...params]
    );
    return rows[0]!.id;
  };
  // 2026-08-09 baseline: bands are STORED by the health job — fabricate them
  // the way the job would (score informs red; signals inform yellow/green).
  const green = await mkContact('Dashgreen', 'dash-green@example.test', 'health_score, health_band', [85, 'green']);
  const red = await mkContact('Dashred', 'dash-red@example.test', 'health_score, health_band', [25, 'red']);

  // Tax engagements at stages with fees.
  for (const [contactId, stage, fee] of [
    [green, 'in_preparation', 40000],
    [red, 'pending_client_response', 30000],
  ] as const) {
    const eng = await app.db.query<{ id: string }>(
      `INSERT INTO engagements (contact_id, service_line, status) VALUES ($1, 'tax', 'active') RETURNING id`,
      [contactId]
    );
    await app.db.query(
      `INSERT INTO tax_engagements (engagement_id, tax_year, return_type, stage, estimated_fee_max_cents, preparer_id, original_deadline)
       VALUES ($1, 2025, '1040', $2::tax_stage, $3, $4, '2026-10-15')`,
      [eng.rows[0]!.id, stage, fee, ana.id]
    );
  }

  // Invoices: one paid this month, one unpaid aged 45 days.
  await app.db.query(
    `INSERT INTO invoices (invoice_number, contact_id, status, subtotal_cents, total_cents, amount_paid_cents, sent_at, paid_at)
     VALUES ('SA-2026-8001', $1, 'paid', 38000, 38000, 38000, now() - interval '3 days', now() - interval '2 days'),
            ('SA-2026-8002', $2, 'sent', 25000, 25000, 0, now() - interval '45 days', NULL)`,
    [green, red]
  );

  // Hilo entrepreneurs + a session with a summary + pro bono time.
  const rosa = await app.db.query<{ id: string }>(
    `INSERT INTO contacts (first_name, last_name, email, hilo_status, zip)
     VALUES ('Synthetic', 'Dashrosa', 'dash-rosa@example.test', 'active', '60608') RETURNING id`
  );
  await app.db.query(
    `INSERT INTO contacts (first_name, last_name, email, hilo_status, zip)
     VALUES ('Synthetic', 'Dashref', 'dash-ref@example.test', 'referral', '60623')`
  );
  const meeting = await app.db.query<{ id: string }>(
    `INSERT INTO meetings (contact_id, staff_id, type, source, status, started_at)
     VALUES ($1, $2, 'in_person', 'manual', 'ready', now()) RETURNING id`,
    [rosa.rows[0]!.id, jackson.id]
  );
  await app.db.query(
    `INSERT INTO meeting_summaries (meeting_id, summary, tax_need) VALUES ($1, 'synthetic recent session', true)`,
    [meeting.rows[0]!.id]
  );
  await app.db.query(
    `INSERT INTO time_entries (staff_id, contact_id, service_type, hours, is_pro_bono, status)
     VALUES ($1, $2, 'hilo_advisory', 2.5, true, 'confirmed')`,
    [jackson.id, rosa.rows[0]!.id]
  );
  await app.db.query(
    `INSERT INTO referrals (contact_id, direction, status, source) VALUES ($1, 'hilo_to_soto', 'pending_approval', 'manual')`,
    [rosa.rows[0]!.id]
  );
});

after(async () => {
  await app.close();
});

test('executive dashboard aggregates trace to the scenario rows; leadership-only', async () => {
  const refused = await app.inject({ method: 'GET', url: '/dashboards/executive', headers: auth(ana) });
  assert.equal(refused.statusCode, 403, 'preparers do not see the executive view (Phase 4 scorecards are own-only)');

  const res = await app.inject({ method: 'GET', url: '/dashboards/executive', headers: auth(brian) });
  assert.equal(res.statusCode, 200, res.body);
  const d = res.json();

  const inPrep = d.openReturnsByStage.find((s: { stage: string }) => s.stage === 'in_preparation');
  assert.equal(inPrep.count, 1);
  assert.equal(Number(inPrep.value_cents), 40000);

  assert.equal(d.revenue.mtdCents, 38000, 'paid invoice lands in MTD');
  assert.equal(d.revenue.ytdCents, 38000);
  assert.equal(d.mrr.cents, 0, 'MRR explicitly deferred to Phase 3');

  const aged = d.arAging.find((b: { bucket: string }) => b.bucket === '31-60');
  assert.equal(aged.count, 1);
  assert.equal(Number(aged.owed_cents), 25000);

  const bands = Object.fromEntries(d.healthDistribution.map((h: { band: string; count: number }) => [h.band, h.count]));
  assert.equal(bands.green, 1);
  assert.equal(bands.red, 1);

  const anaRow = d.staffCapacity.find((s: { full_name: string }) => s.full_name.includes('tax_preparer'));
  assert.equal(anaRow.open_returns, 2);

  assert.ok(d.deadlines.next.length >= 1, 'deadline countdown feeds from M8');
});

test('hilo dashboard: statuses, sessions, queues, summaries, funder metrics (pro bono valued from the price book)', async () => {
  const res = await app.inject({ method: 'GET', url: '/dashboards/hilo', headers: auth(jackson) });
  assert.equal(res.statusCode, 200, res.body);
  const d = res.json();

  const statuses = Object.fromEntries(d.entrepreneursByStatus.map((s: { hilo_status: string; count: number }) => [s.hilo_status, s.count]));
  assert.equal(statuses.active, 1);
  assert.equal(statuses.referral, 1);

  assert.equal(d.sessionsThisMonth, 1);
  assert.equal(d.referralQueues.find((q: { direction: string }) => q.direction === 'hilo_to_soto').pending, 1);
  assert.ok(d.recentSummaries.length >= 1);
  assert.equal(d.milestones30d.items.length, 0, 'milestones explicitly deferred to Phase 2');

  assert.equal(d.funderMetrics.entrepreneursImpacted, 2);
  assert.equal(d.funderMetrics.proBonoHours, 2.5);
  // 2.5h × IND_SPECIALIZED_HOURLY ($150/hr from the seed) = $375.00.
  assert.equal(d.funderMetrics.proBonoValueCents, 37500);
  assert.ok(d.funderMetrics.byNeighborhood.some((n: { zip: string }) => n.zip === '60608'));
});

test('alert center: own notifications only; mark-read; push sweep stamps leadership warnings once', async () => {
  // One warning for Brian (pushes), one info for Brian (does not), one warning for Ana (not leadership).
  await app.db.query(
    `INSERT INTO notifications (staff_id, type, severity, title)
     VALUES ($1, 'test_warning', 'warning', 'Synthetic warning'),
            ($1, 'test_info', 'info', 'Synthetic info'),
            ($2, 'test_prep_warning', 'warning', 'Synthetic preparer warning')`,
    [brian.id, ana.id]
  );

  const list = await app.inject({ method: 'GET', url: '/notifications?unread=true', headers: auth(brian) });
  assert.equal(list.statusCode, 200);
  const mine = list.json().notifications as Array<{ id: string; type: string }>;
  assert.ok(mine.some((n) => n.type === 'test_warning'));
  assert.ok(!mine.some((n) => n.type === 'test_prep_warning'), 'own notifications only');

  const target = mine.find((n) => n.type === 'test_info')!;
  const read = await app.inject({ method: 'POST', url: `/notifications/${target.id}/read`, headers: auth(brian) });
  assert.equal(read.statusCode, 200);
  const foreign = await app.inject({ method: 'POST', url: `/notifications/${target.id}/read`, headers: auth(ana) });
  assert.equal(foreign.statusCode, 404, 'cannot mark someone else’s notification');

  const sweep = await app.inject({ method: 'POST', url: '/jobs/push-sweep', headers: auth(brian) });
  assert.equal(sweep.statusCode, 200, sweep.body);
  assert.ok(sweep.json().pushed >= 1);

  const pushed = await app.db.query(
    `SELECT type, pushed_at FROM notifications WHERE staff_id = $1 AND type LIKE 'test_%'`,
    [brian.id]
  );
  const byType = Object.fromEntries(pushed.rows.map((r: { type: string; pushed_at: string | null }) => [r.type, r.pushed_at]));
  assert.ok(byType.test_warning, 'warning pushed');
  assert.equal(byType.test_info, null, 'info severity never pushes');
  const anaRow = await app.db.query(`SELECT pushed_at FROM notifications WHERE staff_id = $1 AND type = 'test_prep_warning'`, [ana.id]);
  assert.equal(anaRow.rows[0].pushed_at, null, 'non-leadership warnings stay in-app');

  const again = await app.inject({ method: 'POST', url: '/jobs/push-sweep', headers: auth(brian) });
  assert.equal(again.json().pushed, 0, 'stamped once — never re-pushed');
});
