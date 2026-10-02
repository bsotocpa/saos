// R104 (Brian, 2026-09-30): every SQL "today" is Chicago's. The database clock is UTC in production,
// so CURRENT_DATE reads tomorrow from 19:00 Chicago. A test cannot move now(), but CURRENT_DATE follows
// the session's time zone: this spec runs every fixed site with its database set to UTC+14 and then to
// UTC-12. At every Chicago hour at least one of the two puts the server's day on a different date from
// Chicago's (asserted below, so the spec has teeth whenever it runs); code that computes the Chicago day
// answers the same under both. The JavaScript sites run under a mocked clock set to a Chicago evening.
// Synthetic data only.

import { test, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import { createTestConfig, makeContact, makeStaff, type TestStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';
import { CHICAGO_TODAY, chicagoDayOf } from '../src/chicago-day.ts';
import { addDays, todayChicago } from '../src/modules/tax/deadlines.ts';
import { currentPriceBookVersion } from '../src/modules/pricing/service.ts';
import { lateFeeTerms } from '../src/modules/billing/dunning.ts';
import { stampJurisdictionAccepted } from '../src/modules/tax/pipeline.ts';
import { createTask, searchTasks, setTaskStatus, teamWorkload } from '../src/modules/tasks/service.ts';
import { runNoticeEscalations } from '../src/modules/notices/service.ts';
import { closeEngagement } from '../src/modules/engagements/close.ts';
import { withdrawForChangeOrder } from '../src/modules/engagements/change-order.ts';
import { healthSignals } from '../src/modules/crm/health.ts';
import { executiveDashboard } from '../src/modules/dashboards/service.ts';
import { processHiloIntake } from '../src/modules/forms/service.ts';
import { runOnboardingRescueJob } from '../src/modules/portal-auth/onboarding-rescue.ts';

const ZONES = [{ zone: 'Etc/GMT-14', tag: 'east' }, { zone: 'Etc/GMT+12', tag: 'west' }] as const;
let config: Config;
let app: FastifyInstance | null = null;
let staff: TestStaff & { token: string };
const offDay: Record<string, boolean> = {};

after(async () => { if (app) await app.close(); });

async function useZone(zone: string): Promise<FastifyInstance> {
  if (!config) config = await createTestConfig('chicagoday');
  const dbName = new URL(config.DATABASE_URL).pathname.slice(1);
  if (app) {
    await app.db.query(`ALTER DATABASE ${dbName} SET timezone TO '${zone}'`);
    await app.close();
  } else {
    const boot = buildServer(config);
    await boot.ready();
    await boot.db.query(`ALTER DATABASE ${dbName} SET timezone TO '${zone}'`);
    await boot.close();
  }
  app = buildServer(config);
  await app.ready();
  const { rows } = await app.db.query<{ tz: string }>(`SELECT current_setting('TimeZone') AS tz`);
  assert.equal(rows[0]!.tz, zone, 'new sessions run in the zone');
  return app;
}
async function staffWithToken(a: FastifyInstance, email: string, role: string): Promise<TestStaff & { token: string }> {
  const secret = new OTPAuth.Secret({ size: 20 }).base32;
  const s = await makeStaff(a.db, config, { email, name: `Synthetic ${role}`, role, password: `${role}-password-123456`, totpSecret: secret });
  const code = new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) }).generate();
  const res = await a.inject({ method: 'POST', url: '/auth/login', payload: { email, password: s.password, totp: code } });
  assert.equal(res.statusCode, 200, res.body);
  return { ...s, token: res.json().token as string };
}
/** A Chicago wall-clock instant on `day`, as a SQL timestamptz expression. */
const chicagoAt = (day: string, time: string) => `(('${day}'::date + time '${time}') AT TIME ZONE 'America/Chicago')`;

async function engagementFor(a: FastifyInstance, tag: string, last: string): Promise<{ contactId: string; engagementId: string }> {
  const c = await makeContact(a.db, { firstName: 'Synthetic', lastName: `${last}${tag}`, email: `${last.toLowerCase()}-${tag}@example.test` });
  const e = await a.db.query<{ id: string }>(`INSERT INTO engagements (contact_id, service_line, status) VALUES ($1, 'tax', 'active') RETURNING id`, [c.id]);
  return { contactId: c.id, engagementId: e.rows[0]!.id };
}

for (const { zone, tag } of ZONES) {
  test(`every fixed site reads Chicago's day with the database at ${zone}`, async (t) => {
    const a = await useZone(zone);
    staff = await staffWithToken(a, `chicagoday-${tag}@example.test`, 'ceo');
    const T = todayChicago();
    const T1 = addDays(T, 1);
    const serverDay = (await a.db.query<{ d: string }>(`SELECT CURRENT_DATE::text AS d`)).rows[0]!.d;
    offDay[zone] = serverDay !== T;

    await t.test('(c) CHICAGO_TODAY is the Chicago day', async () => {
      const { rows } = await a.db.query<{ d: string }>(`SELECT ${CHICAGO_TODAY}::text AS d`);
      assert.equal(rows[0]!.d, T);
    });

    await t.test('(c) the price book in force: a version effective tomorrow in Chicago is not in force today; the late-fee rate is today\'s', async () => {
      const before = await currentPriceBookVersion(a.db);
      const ratesBefore = await lateFeeTerms(a);
      const v = await a.db.query<{ id: string }>(
        `INSERT INTO price_book_versions (version_number, effective_from, note)
         VALUES ((SELECT max(version_number) + 1 FROM price_book_versions), $1::date, 'R104 spec: effective tomorrow in Chicago') RETURNING id`,
        [T1]
      );
      await a.db.query(
        `INSERT INTO price_book_items
         SELECT (jsonb_populate_record(i, jsonb_build_object('id', gen_random_uuid(), 'version_id', $1::uuid, 'percent_rate', 97))).*
           FROM price_book_items i WHERE i.item_code = 'LATE_FEE_MONTHLY' AND i.version_id = $2`,
        [v.rows[0]!.id, before.id]
      );
      assert.equal((await currentPriceBookVersion(a.db)).id, before.id, 'tomorrow\'s version is not in force today');
      assert.deepEqual(await lateFeeTerms(a), ratesBefore, 'the late-fee rate is today\'s, not tomorrow\'s');
      const admin = await a.inject({ method: 'GET', url: '/admin/price-book', headers: { authorization: `Bearer ${staff.token}` } });
      assert.equal(admin.statusCode, 200, admin.body);
      assert.equal(admin.json().version.pending, true, '(b) the staged version reads pending until its Chicago day');
      // Leave the book as it was for the next zone.
      await a.db.query(`DELETE FROM price_book_items WHERE version_id = $1`, [v.rows[0]!.id]);
      await a.db.query(`DELETE FROM price_book_versions WHERE id = $1`, [v.rows[0]!.id]);
    });

    await t.test('(c) an acknowledgment without a date is accepted on the Chicago day', async () => {
      const { engagementId } = await engagementFor(a, tag, 'Ackday');
      const te = await a.db.query<{ id: string }>(
        `INSERT INTO tax_engagements (engagement_id, tax_year, return_type, stage, original_deadline, filed_date)
         VALUES ($1, 2025, '1040', 'filed', '2026-10-15', $2::date) RETURNING id`,
        [engagementId, T]
      );
      const stamped = await stampJurisdictionAccepted(a, te.rows[0]!.id, 'federal', null);
      assert.notEqual((stamped as { reason?: string }).reason, 'not_declared', JSON.stringify(stamped));
      const { rows } = await a.db.query<{ d: string | null }>(`SELECT federal_accepted_on::text AS d FROM tax_engagements WHERE id = $1`, [te.rows[0]!.id]);
      assert.equal(rows[0]!.d, T);
    });

    await t.test('(c) My Tasks: due today is today in Chicago, and today is not overdue', async () => {
      const today = await createTask(a, { title: `R104 due today ${tag}`, dueDate: T, assignedStaffId: staff.id });
      const tomorrow = await createTask(a, { title: `R104 due tomorrow ${tag}`, dueDate: T1, assignedStaffId: staff.id });
      const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id);
      const dueToday = ids((await searchTasks(a, { dueToday: true, assignedStaffId: staff.id } as never)) as Array<{ id: string }>);
      assert.ok(dueToday.includes(today.id), 'today\'s task is due today');
      assert.ok(!dueToday.includes(tomorrow.id), 'tomorrow\'s is not');
      const overdue = ids((await searchTasks(a, { overdue: true, assignedStaffId: staff.id } as never)) as Array<{ id: string }>);
      assert.ok(!overdue.includes(today.id), 'due today is not overdue');
      const week = ids((await searchTasks(a, { dueThisWeek: true, assignedStaffId: staff.id } as never)) as Array<{ id: string }>);
      assert.ok(week.includes(today.id), 'this week starts today');
      const load = (await teamWorkload(a)) as Array<{ id: string; overdue: number }>;
      assert.equal(load.find((r) => r.id === staff.id)!.overdue, 0, '(b) the workload counts no task due today as overdue');
    });

    await t.test('(c) an IRS notice escalates fourteen Chicago days before its response deadline, not fifteen', async () => {
      const { contactId } = await engagementFor(a, tag, 'Noticeday');
      const n = await a.db.query<{ id: string }>(
        `INSERT INTO irs_notices (contact_id, notice_type, status, response_deadline, received_at, first_actioned_at)
         VALUES ($1, 'CP2000', 'under_review', $2::date, now(), now()) RETURNING id`,
        [contactId, addDays(T, 15)]
      );
      await runNoticeEscalations(a);
      const { rows } = await a.db.query<{ escalated: boolean }>(`SELECT escalated_at IS NOT NULL AS escalated FROM irs_notices WHERE id = $1`, [n.rows[0]!.id]);
      assert.equal(rows[0]!.escalated, false, 'fifteen days out is not yet inside the window');
    });

    await t.test('(c) an engagement closed or superseded without a day ends on the Chicago day', async () => {
      const closed = await engagementFor(a, tag, 'Closeday');
      await closeEngagement(a, closed.engagementId, { outcome: 'withdrawn', withdrawalKind: 'client', reason: 'R104 spec: withdrawn without a day.' }, { type: 'system', label: 'R104 spec' });
      const c1 = await a.db.query<{ d: string }>(`SELECT ended_on::text AS d FROM engagements WHERE id = $1`, [closed.engagementId]);
      assert.equal(c1.rows[0]!.d, T);
      const superseded = await engagementFor(a, tag, 'Changeday');
      await withdrawForChangeOrder(a, superseded.engagementId, randomUUID());
      const c2 = await a.db.query<{ d: string }>(`SELECT ended_on::text AS d FROM engagements WHERE id = $1`, [superseded.engagementId]);
      assert.equal(c2.rows[0]!.d, T);
    });

    await t.test('(b) an hour logged without a day is logged on the Chicago day, by the route and by the column default', async () => {
      const res = await a.inject({ method: 'POST', url: '/time-entries', headers: { authorization: `Bearer ${staff.token}` }, payload: { hours: 1.5, notes: 'R104 spec' } });
      assert.equal(res.statusCode, 201, res.body);
      const r1 = await a.db.query<{ d: string }>(`SELECT entry_date::text AS d FROM time_entries WHERE id = $1`, [res.json().id]);
      assert.equal(r1.rows[0]!.d, T, 'the route');
      const r2 = await a.db.query<{ d: string }>(`INSERT INTO time_entries (staff_id, hours) VALUES ($1, 0.5) RETURNING entry_date::text AS d`, [staff.id]);
      assert.equal(r2.rows[0]!.d, T, 'the column default (0137)');
    });

    await t.test('(b) a Hilo first contact is dated the Chicago day', async () => {
      const c = await makeContact(a.db, { firstName: 'Synthetic', lastName: `Hiloday${tag}`, email: `hiloday-${tag}@example.test` });
      await processHiloIntake(a, randomUUID(), { email: `hiloday-${tag}@example.test`, language: 'en', zip: '60608' } as never).catch(() => undefined);
      const { rows } = await a.db.query<{ d: string | null }>(`SELECT hilo_first_contact::text AS d FROM contacts WHERE id = $1`, [c.id]);
      assert.equal(rows[0]!.d, T);
    });

    await t.test('(b) client health: a document request due today is not overdue; the red clock counts fourteen Chicago days', async () => {
      const { contactId, engagementId } = await engagementFor(a, tag, 'Healthday');
      await a.db.query(
        `INSERT INTO document_requests (contact_id, title_en, status, due_date) VALUES ($1, 'R104 spec request', 'open', $2::date)`,
        [contactId, T]
      );
      await a.db.query(
        `INSERT INTO tax_engagements (engagement_id, tax_year, return_type, stage, original_deadline) VALUES ($1, 2025, '1040', 'in_preparation', $2::date)`,
        [engagementId, addDays(T, 14)]
      );
      const s = await healthSignals(a.db, contactId);
      assert.equal(s.overdue_docs, false, 'due today is not overdue');
      assert.equal(s.red_clock, false, 'a deadline fourteen days out is not inside fourteen days');
    });

    await t.test('(b) the executive flows: a reject whose perfection window closes in three days is not "closing"', async () => {
      const before = (await executiveDashboard(a)).flows.perfectionWindowClosing;
      const { engagementId } = await engagementFor(a, tag, 'Perfectday');
      // A perfection clock is owned by its efile_reject task in the same transaction (0068).
      const client = await (a.db as unknown as { connect(): Promise<{ query: (q: string, p?: unknown[]) => Promise<{ rows: Array<{ id: string }> }>; release(): void }> }).connect();
      try {
        await client.query('BEGIN');
        const te = await client.query(
          `INSERT INTO tax_engagements (engagement_id, tax_year, return_type, stage, original_deadline, perfection_deadline)
           VALUES ($1, 2025, '1040', 'rejected', '2026-10-15', $2::date) RETURNING id`,
          [engagementId, addDays(T, 3)]
        );
        await client.query(`INSERT INTO tasks (title, source_type, source_id) VALUES ('R104 spec reject', 'efile_reject', $1)`, [te.rows[0]!.id]);
        await client.query('COMMIT');
      } finally {
        client.release();
      }
      assert.equal((await executiveDashboard(a)).flows.perfectionWindowClosing, before);
    });

    await t.test('(b) an instant shown as a day is its Chicago day: the dunning fallback and the engagement letter', async () => {
      const { rows } = await a.db.query<{ d: string }>(`SELECT ${chicagoDayOf(chicagoAt(T, '21:30'))}::text AS d`);
      assert.equal(rows[0]!.d, T, 'an invoice sent at 21:30 Chicago was sent that day');
      const { engagementId } = await engagementFor(a, tag, 'Letterday');
      const te = await a.db.query<{ id: string }>(
        `INSERT INTO tax_engagements (engagement_id, tax_year, return_type, stage, original_deadline, engagement_letter_signed_at)
         VALUES ($1, 2025, '1040', 'intake_started', '2026-10-15', ${chicagoAt(T, '21:30')}) RETURNING id`,
        [engagementId]
      );
      const res = await a.inject({ method: 'GET', url: `/tax-engagements/${te.rows[0]!.id}`, headers: { authorization: `Bearer ${staff.token}` } });
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(res.json().taxEngagement.engagement_letter_signed_on, T);
    });
  });
}

test('the two zones put the server\'s day off Chicago\'s at this hour (the spec has teeth whenever it runs)', () => {
  assert.ok(Object.values(offDay).some(Boolean), `at least one zone reads a day other than Chicago's: ${JSON.stringify(offDay)}`);
});

test('(c) the JavaScript sites read Chicago\'s day at 21:30 Chicago: a recurring task\'s next due day, the onboarding stall age', async () => {
  const a = app!;
  // 2026-09-30 21:30 in Chicago is 2026-10-01 02:30 UTC: the UTC day is already tomorrow.
  mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-01T02:30:00Z') });
  try {
    const r = await createTask(a, { title: 'R104 recurring without a due day', assignedStaffId: staff.id, recurFreq: 'monthly', recurInterval: 1 } as never);
    await setTaskStatus(a, r.id, 'completed', { type: 'system', label: 'R104 spec' } as never);
    const { rows } = await a.db.query<{ d: string }>(
      `SELECT due_date::text AS d FROM tasks WHERE title = 'R104 recurring without a due day' AND id <> $1 ORDER BY created_at DESC LIMIT 1`, [r.id]
    );
    assert.equal(rows[0]!.d, '2026-10-30', 'a month after 2026-09-30, the Chicago day it was completed');
  } finally {
    mock.timers.reset();
  }
  // The stall age: opened at 21:30 Chicago sixty days before today is sixty days old today.
  const T = todayChicago();
  const c = await makeContact(a.db, { firstName: 'Synthetic', lastName: 'Stallday', email: 'stallday@example.test' });
  await a.db.query(`INSERT INTO portal_onboarding (contact_id, variant, created_at) VALUES ($1, 'new', ${chicagoAt(addDays(T, -60), '21:30')})`, [c.id]);
  await runOnboardingRescueJob(a, T);
  const { rows } = await a.db.query<{ flagged: boolean }>(`SELECT stalled_flagged_at IS NOT NULL AS flagged FROM portal_onboarding WHERE contact_id = $1`, [c.id]);
  assert.equal(rows[0]!.flagged, true, 'sixty Chicago days old: Brian decides');
});
