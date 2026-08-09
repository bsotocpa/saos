// M27 "Prove it": reports & KPIs + CSV export.
//
// The rules under test:
//   · the CSV is generated from the SAME rows and columns the JSON returns, so
//     an export can never disagree with the screen
//   · money exports as decimal DOLLARS — a spreadsheet showing 25000 for a $250
//     invoice is worse than no export
//   · a text cell that Excel would treat as a formula is neutered (client names
//     and notes reach these files)
//   · revenue that cannot be attributed to a service line is reported as
//     'unattributed', never dropped or folded into a real line
//   · reports are leadership-only, and every export is audited by name + range
//   · "returns filed" and "returns accepted" are separate columns, because
//     Filed is not the finish line — acceptance is

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import type { Mailer } from '../src/mailer.ts';
import { createTestConfig, makeContact, makeStaff, auditRows, type TestStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';
import { toCsv, csvFilename } from '../src/modules/reports/csv.ts';
import { reportCatalog, runReport, REPORTS } from '../src/modules/reports/service.ts';

let app: FastifyInstance;
let config: Config;
let brian: TestStaff & { token: string };
let ana: TestStaff & { token: string };

const silentMailer: Mailer = { transport: 'console', async send() { return { id: 'silent' }; } };
const auth = (t: { token: string }) => ({ authorization: `Bearer ${t.token}` });
const RANGE = { from: '2026-01-01', to: '2026-12-31' };

async function staffWithToken(email: string, role: string): Promise<TestStaff & { token: string }> {
  const secret = new OTPAuth.Secret({ size: 20 }).base32;
  const staff = await makeStaff(app.db, config, {
    email, name: `Synthetic ${role}`, role, password: `${role}-password-123456`, totpSecret: secret,
  });
  const code = new OTPAuth.TOTP({
    algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret),
  }).generate();
  const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: staff.password, totp: code } });
  assert.equal(res.statusCode, 200, res.body);
  return { ...staff, token: res.json().token as string };
}

before(async () => {
  config = await createTestConfig('reports');
  app = buildServer(config, { mailer: silentMailer });
  await app.ready();
  brian = await staffWithToken('brian-rep@example.test', 'ceo');
  ana = await staffWithToken('ana-rep@example.test', 'tax_preparer');
});

after(async () => {
  await app.close();
});

test('the CSV writer is the one place formatting happens, and it is spreadsheet-safe', () => {
  const columns = REPORTS.revenue_by_line_month!.columns;
  const csv = toCsv(columns, [
    { month: '2026-03', service_line: 'tax', invoices: 3, collected_cents: 25000 },
    // A name Excel would evaluate as a formula, plus a comma and a quote.
    { month: '2026-04', service_line: '=SUM(A1:A9)', invoices: 1, collected_cents: 199 },
    { month: '2026-05', service_line: 'Smith, "Bob" LLC', invoices: 2, collected_cents: 0 },
    { month: '2026-06', service_line: 'nothing', invoices: 0, collected_cents: null },
  ]);
  const lines = csv.trimEnd().split('\r\n');

  assert.equal(lines[0], 'Month,Service line,Invoices,Collected', 'headers are the column LABELS');
  // Money in dollars, not cents.
  assert.equal(lines[1], '2026-03,tax,3,250.00');
  assert.equal(lines[2], "2026-04,'=SUM(A1:A9),1,1.99", 'formula trigger is prefixed, not executed');
  assert.equal(lines[3], '2026-05,"Smith, ""Bob"" LLC",2,0.00', 'RFC 4180 quoting');
  assert.equal(lines[4], '2026-06,nothing,0,', 'null money is blank, never 0.00 by accident');
  assert.ok(csv.endsWith('\r\n'), 'CRLF line endings and a clean final newline');

  assert.equal(
    csvFilename('ar_aging', '2026-01-01', '2026-08-09', true),
    'saos-ar-aging-asof-2026-08-09.csv',
    'a snapshot names its as-of date, not a range it does not honour'
  );
  assert.equal(
    csvFilename('revenue_by_line_month', '2026-01-01', '2026-08-09', false),
    'saos-revenue-by-line-month-2026-01-01_to_2026-08-09.csv'
  );
});

test('every catalogued report runs, and its rows only use its declared columns', async () => {
  const catalog = reportCatalog();
  assert.equal(catalog.length, 7, 'seven reports per the spec');
  assert.deepEqual(
    catalog.map((r) => r.key).sort(),
    [
      'ar_aging', 'client_counts', 'pipeline_conversion', 'referral_performance',
      'revenue_by_line_month', 'session_utilization', 'team_throughput',
    ]
  );

  for (const def of catalog) {
    const result = await runReport(app, def.key, RANGE);
    assert.deepEqual(result.columns, def.columns, `${def.key}: catalog and run agree on columns`);
    for (const row of result.rows) {
      for (const col of def.columns) {
        assert.ok(col.key in row, `${def.key}: row is missing declared column '${col.key}'`);
      }
      // No stray keys — otherwise a column exists on screen that the CSV drops.
      const declared = new Set(def.columns.map((c) => c.key));
      for (const key of Object.keys(row)) {
        assert.ok(declared.has(key), `${def.key}: row carries undeclared key '${key}'`);
      }
    }
  }
});

test('reports state their limits instead of approximating: every caveat is real', async () => {
  const catalog = reportCatalog();
  // Session utilization is the one that genuinely cannot measure entitlement
  // yet — it must say so rather than inventing a denominator.
  const sessions = catalog.find((r) => r.key === 'session_utilization')!;
  assert.match(sessions.caveat!, /cannot yet compare usage against an entitlement/i);
  assert.match(sessions.caveat!, /two\s+CPA sessions a year/i, 'the one real rule is still enforced');

  // Snapshot reports must not pretend to honour a date range.
  const snapshots = catalog.filter((r) => r.snapshot).map((r) => r.key).sort();
  assert.deepEqual(snapshots, ['ar_aging', 'client_counts']);
  for (const key of snapshots) {
    assert.match(REPORTS[key]!.caveat!, /date range does not apply/i);
  }

  // Throughput must be explicit that filing is not acceptance.
  assert.match(REPORTS.team_throughput!.caveat!, /acceptance is/i);
});

test('revenue splits by service line and reports unattributable money honestly', async () => {
  const client = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Payer', email: 'payer-rep@example.test' });

  // One invoice tied to a tax engagement, one tied to nothing at all.
  const eng = await app.db.query<{ id: string }>(
    `INSERT INTO engagements (contact_id, service_line, status, title)
     VALUES ($1, 'tax', 'active', 'Synthetic tax') RETURNING id`,
    [client.id]
  );
  const version = await app.db.query<{ id: string }>(
    `SELECT id FROM price_book_versions ORDER BY version_number DESC LIMIT 1`
  );
  for (const [n, engId, cents] of [
    ['SYN-1', eng.rows[0]!.id, 25000],
    ['SYN-2', null, 10000],
  ] as Array<[string, string | null, number]>) {
    await app.db.query(
      `INSERT INTO invoices (invoice_number, contact_id, engagement_id, status, subtotal_cents,
                             total_cents, amount_paid_cents, sent_at, paid_at, price_book_version_id)
       VALUES ($1, $2, $3, 'paid', $4, $4, $4, '2026-03-01', '2026-03-02', $5)`,
      [n, client.id, engId, cents, version.rows[0]!.id]
    );
  }

  const result = await runReport(app, 'revenue_by_line_month', RANGE);
  const byLine = Object.fromEntries(
    result.rows.map((r) => [r.service_line as string, r.collected_cents as number])
  );
  assert.equal(byLine.tax, 25000);
  assert.equal(byLine.unattributed, 10000, 'money with no engagement is named, not silently dropped');
  const total = result.rows.reduce((s, r) => s + (r.collected_cents as number), 0);
  assert.equal(total, 35000, 'the lines sum to everything collected');

  // Out-of-range money is excluded (the range is the range).
  const narrow = await runReport(app, 'revenue_by_line_month', { from: '2026-04-01', to: '2026-04-30' });
  assert.equal(narrow.rows.length, 0);
});

test('throughput separates filed from accepted, so a reject cannot inflate the number', async () => {
  const client = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Filer', email: 'filer-rep@example.test' });
  const eng = await app.db.query<{ id: string }>(
    `INSERT INTO engagements (contact_id, service_line, status) VALUES ($1, 'tax', 'active') RETURNING id`,
    [client.id]
  );
  // Two returns filed by Ana; only one came back accepted.
  await app.db.query(
    `INSERT INTO tax_engagements (engagement_id, tax_year, return_type, stage, preparer_id, filed_date, efile_accepted_at)
     VALUES ($1, 2025, '1040', 'completed', $2, '2026-03-10', '2026-03-11')`,
    [eng.rows[0]!.id, ana.id]
  );
  const eng2 = await app.db.query<{ id: string }>(
    `INSERT INTO engagements (contact_id, service_line, status) VALUES ($1, 'tax', 'active') RETURNING id`,
    [client.id]
  );
  await app.db.query(
    `INSERT INTO tax_engagements (engagement_id, tax_year, return_type, stage, preparer_id, filed_date)
     VALUES ($1, 2024, '1040', 'rejected', $2, '2026-03-12')`,
    [eng2.rows[0]!.id, ana.id]
  );

  const result = await runReport(app, 'team_throughput', RANGE);
  const anaRow = result.rows.find((r) => String(r.staff).includes('tax_preparer'))!;
  assert.equal(anaRow.returns_filed, 2);
  assert.equal(anaRow.returns_accepted, 1, 'the rejected return is filed but NOT accepted');

  // Zero hours must read '0.00', not '0.' — a dangling decimal point looks like
  // a truncated number and makes a real figure look broken.
  for (const row of result.rows) {
    assert.match(String(row.hours_logged), /^\d+\.\d{2}$/, `hours_logged: ${row.hours_logged}`);
    assert.match(String(row.pro_bono_hours), /^\d+\.\d{2}$/, `pro_bono_hours: ${row.pro_bono_hours}`);
  }
});

test('session utilization flags an active S corp below the two-session floor', async () => {
  const owner = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Scorp', email: 'scorp-rep@example.test' });
  await app.db.query(`UPDATE contacts SET soto_status = 'active' WHERE id = $1`, [owner.id]);
  const biz = await app.db.query<{ id: string }>(
    `INSERT INTO businesses (name, entity_type, state) VALUES ('Synthetic S Corp LLC', 's_corp', 'IL') RETURNING id`
  );
  await app.db.query(
    `INSERT INTO business_members (business_id, contact_id, is_primary) VALUES ($1, $2, true)`,
    [biz.rows[0]!.id, owner.id]
  );
  // One session held in the trailing year — below the floor of two.
  await app.db.query(
    `INSERT INTO client_sessions (contact_id, starts_at, status)
     VALUES ($1, now() - interval '30 days', 'completed'), ($1, now() + interval '30 days', 'scheduled')`,
    [owner.id]
  );

  const range = { from: '2020-01-01', to: '2030-12-31' };
  const result = await runReport(app, 'session_utilization', range);
  const row = result.rows.find((r) => String(r.client).includes('Scorp'))!;
  assert.equal(row.held, 1);
  assert.equal(row.scheduled, 1);
  assert.match(String(row.scorp_floor_flag), /BELOW FLOOR \(1\/2\)/);
  assert.match(String(row.entity_types), /s_corp/);

  // A second held session clears it — the flag tracks reality, not a one-time state.
  await app.db.query(
    `INSERT INTO client_sessions (contact_id, starts_at, status)
     VALUES ($1, now() - interval '10 days', 'completed')`,
    [owner.id]
  );
  const after = await runReport(app, 'session_utilization', range);
  assert.equal(after.rows.find((r) => String(r.client).includes('Scorp'))!.scorp_floor_flag, 'ok');
});

test('reports are leadership-only, and a CSV export is audited by name and range', async () => {
  const refused = await app.inject({ method: 'GET', url: '/reports', headers: auth(ana) });
  assert.equal(refused.statusCode, 403, 'a preparer does not read owner analytics');

  const catalog = await app.inject({ method: 'GET', url: '/reports', headers: auth(brian) });
  assert.equal(catalog.statusCode, 200, catalog.body);
  assert.equal(catalog.json().reports.length, 7);
  assert.ok(catalog.json().defaultRange.from.endsWith('-01-01'), 'defaults to year-to-date');

  const json = await app.inject({
    method: 'GET', url: '/reports/revenue_by_line_month?from=2026-01-01&to=2026-12-31', headers: auth(brian),
  });
  assert.equal(json.statusCode, 200, json.body);

  const csv = await app.inject({
    method: 'GET',
    url: '/reports/revenue_by_line_month?from=2026-01-01&to=2026-12-31&format=csv',
    headers: auth(brian),
  });
  assert.equal(csv.statusCode, 200);
  assert.match(csv.headers['content-type'] as string, /text\/csv/);
  assert.match(csv.headers['content-disposition'] as string, /attachment; filename="saos-revenue-by-line-month-2026-01-01_to_2026-12-31\.csv"/);
  // Same numbers, both ways out.
  assert.equal(csv.body.trimEnd().split('\r\n').length, json.json().rows.length + 1);
  assert.ok(csv.body.includes('250.00'), 'dollars, from the same rows the JSON returned');

  // Exactly one export event — reading the JSON above is not an export.
  assert.equal(await auditRows(app.db, 'report.exported'), 1);
  const detail = await app.db.query<{ object_id: string; details: { from: string; to: string; rows: number } }>(
    `SELECT object_id, details FROM audit_log WHERE action = 'report.exported'`
  );
  assert.equal(detail.rows[0]!.object_id, 'revenue_by_line_month');
  assert.equal(detail.rows[0]!.details.from, '2026-01-01');
  assert.equal(detail.rows[0]!.details.to, '2026-12-31');
  assert.equal(detail.rows[0]!.details.rows, json.json().rows.length, 'the audit records how much left');

  const bogus = await app.inject({ method: 'GET', url: '/reports/made_up_report', headers: auth(brian) });
  assert.equal(bogus.statusCode, 404);
  assert.equal(bogus.json().error, 'unknown_report');

  const backwards = await app.inject({
    method: 'GET', url: '/reports/ar_aging?from=2026-12-31&to=2026-01-01', headers: auth(brian),
  });
  assert.equal(backwards.statusCode, 400);
  assert.equal(backwards.json().error, 'bad_range');
});

test('dashboard tiles: never-configured gets defaults, deliberately-empty stays empty', async () => {
  const fresh = await app.inject({ method: 'GET', url: '/reports/tiles/mine', headers: auth(brian) });
  assert.equal(fresh.statusCode, 200, fresh.body);
  assert.equal(fresh.json().configured, false);
  assert.ok(fresh.json().tiles.length > 0, 'a staffer who never chose gets a sensible board');

  const set = await app.inject({
    method: 'PUT', url: '/reports/tiles/mine', headers: auth(brian),
    payload: { tiles: ['ar_aging', 'team_throughput'] },
  });
  assert.equal(set.statusCode, 200, set.body);
  assert.deepEqual(set.json().tiles, ['ar_aging', 'team_throughput']);

  const reread = await app.inject({ method: 'GET', url: '/reports/tiles/mine', headers: auth(brian) });
  assert.deepEqual(reread.json().tiles, ['ar_aging', 'team_throughput']);
  assert.equal(reread.json().configured, true);

  // Clearing every tile is a real choice, not a reset to defaults.
  await app.inject({ method: 'PUT', url: '/reports/tiles/mine', headers: auth(brian), payload: { tiles: [] } });
  const emptied = await app.inject({ method: 'GET', url: '/reports/tiles/mine', headers: auth(brian) });
  assert.deepEqual(emptied.json().tiles, [], 'an empty board stays empty');
  assert.equal(emptied.json().configured, true);

  // A tile that is not a report is refused rather than rendering as a blank card.
  const bad = await app.inject({
    method: 'PUT', url: '/reports/tiles/mine', headers: auth(brian),
    payload: { tiles: ['ar_aging', 'not_a_report'] },
  });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().error, 'unknown_report');
});
