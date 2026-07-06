// M22 "Prove it": parsers, rules, and the executor — against SYNTHETIC
// fixtures only (CLAUDE.md: no real client data in tests). The decisive
// assertions: Login Details route to the Vaultwarden export and appear
// NOWHERE in the database; dry run writes no entity rows; execute is
// idempotent.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import pg from 'pg';
import { parseCsv } from '../src/migration/csv.ts';
import {
  moneyToCents, normalizeEntityType, normalizePhone, parseDateish,
  parseDubsado, parseGrantTracker, parseZoho,
} from '../src/migration/sources.ts';
import { buildPlan, mapGrantStatus } from '../src/migration/plan.ts';
import { executePlan } from '../src/migration/execute.ts';
import { createTestConfig } from './helpers.ts';

const AS_OF = '2026-07-06';
const SECRET = 'synthetic-hunter2-xyz'; // distinctive: we grep the DB for its ABSENCE

let dir: string;
let db: pg.Pool;

function csv(rows: string[][]): string {
  return rows.map((r) => r.map((c) => `"${c.replaceAll('"', '""')}"`).join(',')).join('\r\n');
}

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'saos-migration-test-'));
  await mkdir(path.join(dir, 'zoho-extracted', 'Data'), { recursive: true });

  // Dubsado (real-world file names): one active (≤24mo), one inactive
  // (24–36mo), one ancient-but-rescued-by-a-project, one truly ancient
  // (skip), one internal duplicate by email.
  await writeFile(
    path.join(dir, 'dubsado_clients.csv'),
    csv([
      ['firstName', 'lastName', 'email', 'phone', 'addressString', 'title', 'start'],
      ['Synthetic', 'Alpha', 'alpha@example.test', '(312) 555-0101', '1 Test St, Chicago IL', 'Owner', '2023-02-01'],
      ['Synthetic', 'Beta', 'beta@example.test', '312-555-0102', '', '', '2022-05-01'],
      ['Synthetic', 'Gamma', 'gamma@example.test', '', '', '', '2019-01-01'],
      ['Synthetic', 'Omega', 'omega@example.test', '', '', '', '2018-01-01'],
      ['Synthetic', 'AlphaDup', 'alpha@example.test', '', '', '', '2024-01-01'],
    ])
  );
  // Invoices: Alpha paid recently (drives 'active'); Beta's last touch 2024-05 (inactive bucket).
  await writeFile(
    path.join(dir, 'dubsado_invoices.csv'),
    csv([
      ['Invoice Number', 'Date', 'Title', 'Invoice Project', 'Client', 'Payment Date(s)', 'Payment Method(s)', 'Subtotal', 'Tax', 'Total', 'Amount Paid', 'Outstanding Balance', 'Status', 'QuickBooks Status'],
      ['1001', 'Mar 3, 2026', '1040', '', 'Synthetic Alpha', 'Mar 10, 2026', 'card', '500', '0', '500', '500', '0', 'Paid', ''],
      ['0900', 'May 2, 2024', '1040', '', 'Synthetic Beta', 'May 9, 2024', 'card', '400', '0', '400', '400', '0', 'Paid', ''],
    ])
  );
  // Projects (email-keyed): rescue Gamma with recent work; give Alpha a
  // company + split address; one project email not in the roster.
  await writeFile(
    path.join(dir, 'dubsado_projects_2026-07-06.csv'),
    csv([
      ['Project title', 'Project status', 'Contact name', 'Contract status', 'Created date', 'Start date', 'Primary invoice paid', 'Client first name', 'Client last name', 'Client phone', 'Client email', 'Client address Line 1', 'Client address Line 2', 'Client address City', 'Client address State', 'Client address Zip', 'Client address Country', 'Company name', 'Company phone', 'Company email', 'Company'],
      ['2025 1040', 'Completed', 'Synthetic Gamma', 'Signed', '2026-02-15', '2026-03-01', 'true', 'Synthetic', 'Gamma', '', 'gamma@example.test', '', '', '', '', '', '', '', '', '', ''],
      ['Bookkeeping', 'Active', 'Synthetic Alpha', 'Signed', '2026-01-10', '', 'true', 'Synthetic', 'Alpha', '', 'alpha@example.test', '1 Test St', '', 'Chicago', 'IL', '60601', 'US', 'Alpha Ventures LLC', '', '', ''],
      ['Old engagement', 'Completed', 'Rogue Person', 'Signed', '2026-05-01', '', 'true', 'Rogue', 'Person', '', 'rogue@example.test', '', '', '', '', '', '', '', '', '', ''],
    ])
  );

  const z = (name: string, rows: string[][]) =>
    writeFile(path.join(dir, 'zoho-extracted', 'Data', name), csv(rows));
  // Zoho contacts: one merges into Alpha (same email, adds city/zip); one new
  // recent; one stale-but-TAGGED (kept); one stale untagged (skipped).
  await z('Contacts_001.csv', [
    ['Record Id', 'First Name', 'Last Name', 'Email', 'Secondary Email', 'Phone', 'Mobile', 'Home Phone', 'Other Phone', 'Mailing Street', 'Mailing City', 'Mailing State', 'Mailing Zip', 'Description', 'Account Name.id', 'Tag', 'Created Time', 'Modified Time', 'Last Activity Time'],
    ['z1', 'Synthetic', 'Alpha', 'alpha@example.test', '', '', '', '', '', '1 Test St', 'Chicago', 'IL', '60601', 'longtime client', 'a1', '', '2020-01-01 09:00:00', '2026-03-01 09:00:00', ''],
    ['z2', 'Synthetic', 'Delta', 'delta@example.test', '', '(312) 555-0104', '', '', '', '', 'Chicago', 'IL', '60602', '', 'a2', '', '2025-01-01 09:00:00', '2026-05-01 09:00:00', ''],
    ['z3', 'Synthetic', 'Epsilon', 'epsilon@example.test', '', '', '', '', '', '', '', '', '', '', '', 'VIP', '2019-01-01 09:00:00', '2020-01-01 09:00:00', ''],
    ['z4', 'Synthetic', 'Zeta', 'zeta@example.test', '', '', '', '', '', '', '', '', '', '', '', '', '2019-01-01 09:00:00', '2020-01-01 09:00:00', ''],
  ]);
  // Accounts: a2 is a REAL business (EIN + entity); a1 is a personal shell
  // (name = the person, no business data); a9 has no imported owner.
  await z('Accounts_001.csv', [
    ['Record Id', 'Account Name', 'DBA', 'EIN', 'Entity', 'Industry', 'IRS Business Codes', 'Website', 'Phone', 'Email', 'Billing State', 'State', 'Billing Code', 'Formation Date', 'File Number', 'Registered Agent', 'Modified Time', 'Last Activity Time'],
    ['a1', 'Synthetic Alpha', '', '', '', '', '', '', '', '', 'IL', '', '', '', '', '', '2026-03-01 09:00:00', ''],
    ['a2', 'Delta Foods LLC', 'Delta Kitchen', '12-3456789', 'LLC', 'Food & Beverage', '722511', 'https://delta.example.test', '', '', 'IL', '', '60602', '2021-06-01 09:00:00', 'LLC-99887', 'Synthetic Delta', '2026-05-01 09:00:00', ''],
    ['a9', 'Orphan Ventures Inc', '', '98-7654321', 'C Corp', '', '', '', '', '', 'IL', '', '', '', '', '', '2026-01-01 09:00:00', ''],
  ]);
  await z('Leads_001.csv', [
    ['Record Id', 'First Name', 'Last Name', 'Company', 'Email', 'Phone', 'Mobile', 'Is Converted', 'Modified Time', 'Last Activity Time'],
    ['l1', 'Synthetic', 'Eta', 'Eta Bakery', 'eta@example.test', '', '', 'false', '2026-06-01 09:00:00', ''],
    ['l2', 'Synthetic', 'Theta', '', 'theta@example.test', '', '', 'true', '2026-06-01 09:00:00', ''],
  ]);
  await z('Contacts X Accounts_C_001.csv', [
    ['Record Id', 'Accounts.id', 'Multi-Select Lookup 1.id'],
    ['x1', 'a2', 'z2'],
  ]);

  // Grant Tracker workbook: 2025-style sheet (split login columns) with a
  // month section row + hyperlink; 2023-style sheet (combined column).
  const wb = new ExcelJS.Workbook();
  const s25 = wb.addWorksheet('2025 - Test Grant Tracker');
  s25.addRow(['Name', 'Status/Result', 'Internal Deadline', 'Deadline', 'Lead', 'Submission Type', 'Program', 'Grant Amount', 'Link to Funding Materials', 'Login Details (username/email)', 'Login Details (password)', 'Date Received (if applicable)', 'Notes', 'Timeframe']);
  s25.addRow(['January']); // section label — must be skipped
  s25.addRow(['Synthetic Growth Fund', 'Approved', new Date('2025-02-01'), new Date('2025-03-01'), 'Synthetic Lead', 'Application', 'Kitchen Ops', '$5,000', { text: 'Materials', hyperlink: 'https://funder.example.test/apply' }, 'grants@example.test', SECRET, new Date('2025-04-15'), 'award letter on file', 'Q1']);
  s25.addRow(['Synthetic Micro Grant', 'Submitted', '', new Date('2025-06-01'), '', 'LOI', '', 'Up to $2,500', '', '', '', '', '', 'Q2']);
  const s23 = wb.addWorksheet('2023 - Test Grant Tracker');
  s23.addRow(['Name', 'Status/Result', 'Lead', 'TImeframe', 'Submission Type', 'Program', 'Grant Amount', 'Deadline', 'Internal Deadline', 'Lead 2', 'Link to Funding Materials', 'Login Details (username/email/password)', 'Date Received (if applicable)', 'Notes']);
  s23.addRow(['Synthetic Legacy Grant', 'Denied', 'Synthetic Lead', 'FY23', 'Proposal', '', '1000', new Date('2023-05-01'), '', '', '', `legacy@example.test / ${SECRET}`, '', 'reapply next year']);
  await wb.xlsx.writeFile(path.join(dir, 'Test Grant Tracker.xlsx'));

  const config = await createTestConfig('migration');
  db = new pg.Pool({ connectionString: config.DATABASE_URL });
});

after(async () => {
  await db.end();
  await rm(dir, { recursive: true, force: true });
});

// ── unit: parsers + normalizers ──────────────────────────────────────────────

test('csv parser: quoted commas, escaped quotes, embedded newlines, BOM', () => {
  const rows = parseCsv('﻿a,b\r\n"1,5","say ""hi""\nsecond line"\r\n');
  assert.deepEqual(rows, [['a', 'b'], ['1,5', 'say "hi"\nsecond line']]);
});

test('normalizers: dates, money, phones, entity types, grant statuses', () => {
  assert.equal(parseDateish('2026-03-01 09:15:00'), '2026-03-01');
  assert.equal(parseDateish('3/9/2026'), '2026-03-09');
  assert.equal(parseDateish('Mar 10, 2026'), '2026-03-10');
  assert.equal(parseDateish('n/a'), null);
  assert.equal(moneyToCents('$5,000'), 500000);
  assert.equal(moneyToCents('Up to $2,500'), null);
  assert.equal(normalizePhone('(312) 555-0101'), '3125550101');
  assert.equal(normalizePhone('+1 312 555 0101'), '3125550101');
  assert.equal(normalizeEntityType('S-Corp'), 's_corp');
  assert.equal(normalizeEntityType('Sole Proprietor'), 'sole_prop');
  assert.equal(normalizeEntityType('NFP'), 'nonprofit');
  assert.equal(normalizeEntityType('mystery co'), null);
  assert.equal(mapGrantStatus('Approved - $5k!'), 'approved');
  assert.equal(mapGrantStatus('Not selected'), 'denied');
  assert.equal(mapGrantStatus(null), 'prospect');
});

test('grant tracker: month labels skipped; credentials separated in BOTH column shapes; raw stripped', async () => {
  const t = await parseGrantTracker(path.join(dir, 'Test Grant Tracker.xlsx'));
  assert.equal(t.grants.length, 3);
  assert.equal(t.sheets.find((s) => s.name.includes('2025'))!.sectionRows, 1); // "January"

  const approved = t.grants.find((g) => g.funder === 'Synthetic Growth Fund')!;
  assert.equal(approved.amountCents, 500000);
  assert.equal(approved.materialsLink, 'https://funder.example.test/apply');
  assert.equal(approved.hadCredentials, true);

  // Two credential items: split (2025) + combined (2023).
  assert.equal(t.credentials.length, 2);
  const split = t.credentials.find((c) => c.grantName === 'Synthetic Growth Fund')!;
  assert.equal(split.username, 'grants@example.test');
  assert.equal(split.password, SECRET);
  const combined = t.credentials.find((c) => c.grantName === 'Synthetic Legacy Grant')!;
  assert.ok(combined.combined!.includes(SECRET));

  // THE assertion: no grant row carries the secret anywhere — including raw.
  assert.ok(!JSON.stringify(t.grants).includes(SECRET), 'credentials must never ride on grant rows');
});

// ── plan rules ───────────────────────────────────────────────────────────────

async function loadPlan() {
  const dubsado = await parseDubsado(dir);
  const zoho = await parseZoho(dir);
  const tracker = await parseGrantTracker(path.join(dir, 'Test Grant Tracker.xlsx'));
  return {
    plan: buildPlan(
      { dubsado: dubsado.clients, zoho, grants: tracker.grants, credentials: tracker.credentials },
      { today: AS_OF, dubsadoWindowMonths: 36, zohoInactiveMonths: 36 }
    ),
    tracker,
    dubsado,
  };
}

test('plan: activity windows, project rescue, tag exception, merge fill-don\'t-overwrite, lead handling', async () => {
  const { plan, dubsado } = await loadPlan();
  const byName = new Map(plan.contacts.map((c) => [`${c.firstName} ${c.lastName}`, c]));

  // Dubsado buckets: Alpha active (invoice 2026-03), Beta inactive (2024-05),
  // Gamma RESCUED to active by a 2026 project (email join), Omega skipped.
  assert.equal(byName.get('Synthetic Alpha')!.sotoStatus, 'active');
  assert.equal(byName.get('Synthetic Beta')!.sotoStatus, 'inactive');
  assert.equal(byName.get('Synthetic Gamma')!.sotoStatus, 'active');
  assert.ok(!byName.has('Synthetic Omega'));
  assert.ok(plan.skipped.some((s) => s.sourceRef === 'omega@example.test' && s.reason.includes('inactive')));
  // Internal dup by email skipped.
  assert.ok(plan.skipped.some((s) => s.source === 'dubsado' && s.reason.includes('duplicate')));
  // Projects with emails outside the roster surface for review.
  assert.deepEqual(dubsado.projectEmailsNotInRoster, ['rogue@example.test']);

  // Merge: Alpha carries the project's company + split address, Zoho fills
  // remaining gaps, and Dubsado stays the system of record.
  const alpha = byName.get('Synthetic Alpha')!;
  assert.equal(alpha.city, 'Chicago');
  assert.equal(alpha.zip, '60601');
  assert.ok(alpha.notes!.includes('Alpha Ventures LLC'));
  assert.equal(alpha.source, 'dubsado');
  assert.equal(alpha.sources.length, 2);

  // Zoho-only recent → lead; stale+tagged kept; stale untagged skipped.
  assert.equal(byName.get('Synthetic Delta')!.sotoStatus, 'lead');
  assert.ok(byName.has('Synthetic Epsilon'), 'tagged records survive the inactivity window');
  assert.ok(!byName.has('Synthetic Zeta'));

  // Leads: unconverted imported, converted skipped.
  assert.ok(byName.has('Synthetic Eta'));
  assert.ok(plan.skipped.some((s) => s.source === 'zoho_lead' && s.reason.includes('converted')));

  // Enrichment gaps: Beta has no city… but the queue tracks email/phone only for contacts —
  // Epsilon (no phone) must be flagged.
  assert.ok(byName.get('Synthetic Epsilon')!.missingFields.includes('phone'));
});

test('plan: businesses — real ones import with owners, shells and orphans do not', async () => {
  const { plan } = await loadPlan();
  assert.equal(plan.businesses.length, 1);
  const delta = plan.businesses[0]!;
  assert.equal(delta.name, 'Delta Foods LLC');
  assert.equal(delta.entityType, 'llc');
  assert.equal(delta.ein, '12-3456789');
  assert.equal(delta.ownerKeys.length, 1);
  assert.equal(plan.stats.accounts_skipped_personal_shell, 1);
  assert.equal(plan.stats.accounts_skipped_no_imported_owner, 1);
  // The business's missing industry/ein gaps ride on the owner's queue…
  assert.equal(delta.missingFields.length, 0); // ein+entity+industry all present here
});

// ── executor ─────────────────────────────────────────────────────────────────

test('execute: dry run writes bookkeeping only; execute loads; re-run is all duplicates; secrets absent', async () => {
  const { plan } = await loadPlan();

  const countRows = async (sql: string) => Number((await db.query(sql)).rows[0].n);
  const contactsBefore = await countRows(`SELECT count(*)::int AS n FROM contacts`);

  // DRY RUN: no entity writes; batches recorded with dry_run = true.
  const dry = await executePlan(db, plan, { dryRun: true, dirLabel: 'synthetic' });
  assert.equal(dry.contactsCreated, 0);
  assert.equal(await countRows(`SELECT count(*)::int AS n FROM contacts`), contactsBefore);
  assert.equal(await countRows(`SELECT count(*)::int AS n FROM import_batches WHERE dry_run`), 3);
  assert.equal(await countRows(`SELECT count(*)::int AS n FROM import_records`), 0);

  // EXECUTE.
  const run = await executePlan(db, plan, { dryRun: false, dirLabel: 'synthetic' });
  assert.equal(run.contactsCreated, plan.contacts.length);
  assert.equal(run.businessesCreated, 1);
  assert.equal(run.grantsCreated, 3);
  assert.ok(run.enrichmentQueued > 0);

  const alpha = await db.query(
    `SELECT soto_status, source, city FROM contacts WHERE email = 'alpha@example.test'`
  );
  assert.equal(alpha.rows[0].soto_status, 'active');
  assert.equal(alpha.rows[0].source, 'dubsado');
  assert.equal(alpha.rows[0].city, 'Chicago');

  const owners = await db.query(
    `SELECT c.email FROM business_members bm
     JOIN businesses b ON b.id = bm.business_id JOIN contacts c ON c.id = bm.contact_id
     WHERE b.name = 'Delta Foods LLC'`
  );
  assert.deepEqual(owners.rows.map((r) => r.email), ['delta@example.test']);

  // THE compliance assertion: the credential string exists NOWHERE in the DB.
  for (const probe of [
    `SELECT count(*)::int AS n FROM grants_received WHERE grants_received::text LIKE '%${SECRET}%'`,
    `SELECT count(*)::int AS n FROM import_records WHERE raw::text LIKE '%${SECRET}%'`,
    `SELECT count(*)::int AS n FROM audit_log WHERE details::text LIKE '%${SECRET}%'`,
  ]) {
    assert.equal(await countRows(probe), 0, 'funder credentials must never reach the database');
  }
  // …but the grant rows themselves landed, with the routing marker in raw.
  const marked = await db.query(
    `SELECT count(*)::int AS n FROM import_records WHERE raw::text LIKE '%[routed-to-vaultwarden]%'`
  );
  assert.ok(Number(marked.rows[0].n) >= 2);

  // IDEMPOTENCE: run again → nothing new, everything duplicate.
  const rerun = await executePlan(db, plan, { dryRun: false, dirLabel: 'synthetic' });
  assert.equal(rerun.contactsCreated, 0);
  assert.equal(rerun.contactsDuplicate, plan.contacts.length);
  assert.equal(rerun.businessesCreated, 0);
  assert.equal(rerun.grantsCreated, 0);
  assert.equal(rerun.grantsDuplicate, 3);
  assert.equal(await countRows(`SELECT count(*)::int AS n FROM contacts`), contactsBefore + plan.contacts.length);

  // Native records untouched by design: import never UPDATEs contacts.
  const audit = await db.query(
    `SELECT count(*)::int AS n FROM audit_log WHERE action = 'import.executed'`
  );
  assert.ok(Number(audit.rows[0].n) >= 2);
});
