// THE TEST-CLIENT FLAG (2026-09-09, Brian's ruling).
//
// A contact with is_test = true is workable everywhere — quotes, invoices, tasks — and is
// excluded from every NUMBER: A/R aging, the executive dashboard, every report tile, every
// client count. The rule is stated as one behaviour rather than a list of queries: a test
// client, given money, work and a pipeline stage, changes no report and no dashboard figure.
// If a future query forgets `NOT c.is_test`, this is the test that fails.
//
// Synthetic data only.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import type { Mailer } from '../src/mailer.ts';
import { createTestConfig, makeContact, makeStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';
import { REPORTS, runReport } from '../src/modules/reports/service.ts';
import { executiveDashboard } from '../src/modules/dashboards/service.ts';
import { createQuote, sendQuote } from '../src/modules/pricing/quotes.ts';
import { createTask } from '../src/modules/tasks/service.ts';

let app: FastifyInstance;
let config: Config;
let staffId = '';

const silentMailer: Mailer = { transport: 'console', async send() { return { id: 'silent' }; } };
const RANGE = { from: '2020-01-01', to: '2030-12-31' };

async function everyNumber(): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(REPORTS)) {
    out[`report:${key}`] = (await runReport(app, key, RANGE)).rows;
  }
  // The dashboard carries timestamps and "since" fields that move with the clock; keep
  // the numbers and drop anything that is a date.
  const dash = JSON.parse(JSON.stringify(await executiveDashboard(app))) as Record<string, unknown>;
  const strip = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(strip);
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .filter(([k]) => !/(_at|_since|date|updated|generated)$/i.test(k))
          .map(([k, val]) => [k, strip(val)])
      );
    }
    return v;
  };
  out.dashboard = strip(dash);
  return out;
}

async function quotableItem(): Promise<string> {
  const { rows } = await app.db.query<{ item_code: string }>(
    `SELECT pbi.item_code FROM price_book_items pbi JOIN price_book_versions v ON v.id = pbi.version_id
      WHERE pbi.is_active AND pbi.display_on_quote AND pbi.amount_cents IS NOT NULL
        AND v.effective_from <= CURRENT_DATE AND (v.effective_to IS NULL OR v.effective_to > CURRENT_DATE)
      ORDER BY pbi.item_code LIMIT 1`);
  return rows[0]!.item_code;
}

before(async () => {
  config = await createTestConfig('testclient');
  app = buildServer(config, { mailer: silentMailer });
  await app.ready();
  const s = await makeStaff(app.db, config, { email: 'ceo-testclient@example.test', name: 'Synthetic CEO', role: 'ceo', password: 'ceo-password-1234567' });
  staffId = s.id;
});

after(async () => {
  await app.close();
});

test('a test client with money, work and a pipeline stage changes no report and no dashboard number', async () => {
  const before_ = await everyNumber();

  // The rehearsal client: active, in the pipeline, quoted, invoiced, paid, owing, and worked.
  const c = await makeContact(app.db, { firstName: 'Rehearsal', lastName: 'Ghost', email: 'rehearsal-ghost@example.test' });
  await app.db.query(
    // contacts_test_has_note: the database refuses a test flag without a note saying why.
    `UPDATE contacts SET is_test = true, test_note = 'Synthetic rehearsal client for the exclusion test',
            soto_status = 'active', lead_stage = 'quoted', lead_stage_at = now() WHERE id = $1`,
    [c.id]
  );
  const actor = { id: staffId, email: 'ceo-testclient@example.test', fullName: 'Synthetic CEO', roleKey: 'ceo' as const, permissions: ['*'], sessionId: 'test' };
  const quote = await createQuote(app, { contactId: c.id, lines: [{ itemCode: await quotableItem() }] }, actor);
  await sendQuote(app, quote.id, actor);
  await app.db.query(`UPDATE quotes SET status = 'accepted', accepted_at = now() WHERE id = $1`, [quote.id]);
  await app.db.query(
    `INSERT INTO invoices (invoice_number, contact_id, status, subtotal_cents, total_cents, amount_paid_cents, sent_at, paid_at)
     VALUES ('SG-2026-0001', $1, 'paid', 123400, 123400, 123400, now() - interval '5 days', now() - interval '4 days'),
            ('SG-2026-0002', $1, 'overdue', 55500, 55500, 0, now() - interval '70 days', NULL)`,
    [c.id]
  );
  const task = await createTask(app, {
    title: 'Rehearsal work', assignedStaffId: staffId, contactId: c.id, source: 'manual', sourceType: 'manual', sourceId: `ghost-${c.id}`,
  });
  await app.db.query(`UPDATE tasks SET status = 'completed', completed_at = now() WHERE id = $1`, [task.id]);

  const after_ = await everyNumber();
  for (const key of Object.keys(before_)) {
    assert.deepEqual(after_[key], before_[key], `${key} moved because of a test client`);
  }
});

test('the same client, un-flagged, DOES move the numbers — so the test above is not vacuous', async () => {
  const before_ = await everyNumber();
  await app.db.query(`UPDATE contacts SET is_test = false WHERE email = 'rehearsal-ghost@example.test'`);
  const after_ = await everyNumber();
  const moved = Object.keys(before_).filter((k) => JSON.stringify(after_[k]) !== JSON.stringify(before_[k]));
  assert.ok(moved.includes('report:ar_aging'), 'A/R aging sees the overdue invoice once the flag is off');
  assert.ok(moved.includes('report:revenue_by_line_month'), 'revenue sees the paid invoice');
  assert.ok(moved.includes('report:pipeline_conversion'), 'pipeline conversion sees the quote');
  assert.ok(moved.includes('report:client_counts'), 'client counts see the active client');
  assert.ok(moved.includes('dashboard'), 'the executive dashboard moves');
  // Put it back: the flag is the only difference between a ghost and a client.
  await app.db.query(`UPDATE contacts SET is_test = true WHERE email = 'rehearsal-ghost@example.test'`);
});
