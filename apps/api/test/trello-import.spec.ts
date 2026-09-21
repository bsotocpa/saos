/*
 * THE TRELLO IMPORT'S TWO CUTOVER RULES (Brian, 2026-09-20, R22 and R23).
 *
 * These are separate from test/import-mode.spec.ts on purpose. That spec covers the two halves of
 * R16 — nothing is SENT, nothing is FABRICATED — which are properties of the import mechanism. This
 * one covers what the import must DO at a cutover, which is a different kind of rule: a precondition
 * that stops the run, and the three shapes a return at or past `filed` takes.
 *
 *   R22  the import refuses to run with no active tax_preparer, and an imported return otherwise
 *        takes the firm's sole active preparer (R11's default). Several active preparers is NOT a
 *        refusal — the firm chooses — and the return lands unassigned.
 *
 *   R23  "filed, awaiting ack" declares the R2 address default, every row FLAGGED as a default;
 *        "accepted, client not yet notified" and "paper filed" import as completed with no
 *        acceptance row invented.
 *   R31  (R23 amended) the method is the YEAR'S lane: current + 2 prior e-file, older PAPER — an old
 *        year is declared paper, flagged, with no mailing invented, never refused and never e-filed.
 *   R33  a sales-tax or payroll fact lands on a sales_tax / payroll ENGAGEMENT (0106's
 *        filing_frequency, 0107's payroll_provider), found or created through the ordinary door,
 *        idempotent on the (source, trello_source_id, fact_type) ledger; a closed service creates
 *        nothing; a value a person already set is never overwritten.
 *
 * Synthetic data only.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import { createTestConfig, makeContact, makeStaff, businessFor } from './helpers.ts';
import type { Config } from '../src/config.ts';
import type { AuthedStaff } from '../src/types.ts';
import { assertImportPreconditions, declareImportedJurisdictions, setImportedStage } from '../src/modules/tax/import.ts';
import { applyNewReturnDefaults } from '../src/modules/tax/pipeline.ts';
import { applyRecurringServiceFact, isLiveServiceFact, normalizeFilingFrequency } from '../src/modules/engagements/import-facts.ts';

let app: FastifyInstance;
let config: Config;
let ceoId = '';

const IMPORT_LABEL = 'trello import rehearsal 2026-09-20 (synthetic)';
const BUNDLE_DATE = '2026-09-19';
const actor = { staffId: null as string | null, label: IMPORT_LABEL };

before(async () => {
  config = await createTestConfig('trello_import');
  app = buildServer(config, {});
  await app.ready();
  const ceo = await makeStaff(app.db, config, {
    email: 'ceo-trello@example.test', name: 'Synthetic CEO', role: 'ceo', password: 'ceo-password-1234567',
  });
  ceoId = ceo.id;
});

after(async () => {
  await app.close();
});

let seq = 0;

/** A fresh return the import just created: intake_started, no gate fact of any kind. */
async function freshReturn(opts: { year?: number; state?: string | null; letterSigned?: boolean } = {}): Promise<{
  teId: string; contactId: string;
}> {
  seq++;
  const c = await makeContact(app.db, {
    firstName: 'Trello', lastName: `Import${seq}`, email: `trello.import${seq}@example.test`,
  });
  if (opts.state !== undefined) {
    await app.db.query(`UPDATE contacts SET state = $2 WHERE id = $1`, [c.id, opts.state]);
  }
  if (opts.letterSigned) {
    await app.db.query(`UPDATE contacts SET engagement_letter_status = 'signed' WHERE id = $1`, [c.id]);
  }
  const eng = await app.db.query<{ id: string }>(
    `INSERT INTO engagements (contact_id, service_line, title, status, source, trello_card_id)
     VALUES ($1, 'tax', 'imported return', 'active', 'trello', $2) RETURNING id`,
    [c.id, `card-${seq}`]
  );
  const te = await app.db.query<{ id: string }>(
    `INSERT INTO tax_engagements (engagement_id, tax_year, return_type, client_type, source, trello_card_id)
     VALUES ($1, $2, '1040', 'individual', 'trello', $3) RETURNING id`,
    [eng.rows[0]!.id, opts.year ?? 2025, `card-${seq}`]
  );
  return { teId: te.rows[0]!.id, contactId: c.id };
}

async function preparers(): Promise<number> {
  const { rows } = await app.db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM staff s JOIN roles r ON r.id = s.role_id WHERE s.is_active AND r.key = 'tax_preparer'`
  );
  return rows[0]!.n;
}

async function deactivateAllPreparers(): Promise<void> {
  await app.db.query(
    `UPDATE staff SET is_active = false
      WHERE role_id = (SELECT id FROM roles WHERE key = 'tax_preparer')`
  );
}

// ── R22: THE CUTOVER PRECONDITION ──────────────────────────────────────────

test('R22: with NO active tax_preparer the import refuses, and the refusal says what to do', async () => {
  await deactivateAllPreparers();
  assert.equal(await preparers(), 0, 'the fixture really has none');

  await assert.rejects(
    () => assertImportPreconditions(app),
    (err: unknown) => {
      const e = err as { code?: string; message?: string; statusCode?: number };
      assert.equal(e.code, 'no_active_tax_preparer');
      /*
       * The wording is asserted, not just the code. This refusal is the only thing standing between a
       * cutover and 44 returns in nobody's queue, and a message that does not say "create the preparer
       * account" sends somebody to read code at the worst possible moment.
       */
      assert.match(e.message ?? '', /unassigned/i, 'it says what goes wrong');
      assert.match(e.message ?? '', /cutover/i, 'and that this is a cutover precondition');
      return true;
    }
  );
});

test('R22: with ONE active tax_preparer the import proceeds and the return takes them as its default', async () => {
  await deactivateAllPreparers();
  const rene = await makeStaff(app.db, config, {
    email: 'preparer-one@example.test', name: 'Synthetic Preparer', role: 'tax_preparer', password: 'prep-password-1234567',
  });
  assert.equal(await preparers(), 1);

  const pre = await assertImportPreconditions(app);
  assert.equal(pre.activePreparers, 1);
  assert.equal(pre.defaultPreparerId, rene.id, 'the sole active preparer is the default (R11)');

  const { teId, contactId } = await freshReturn();
  await setImportedStage(app, actor, { taxEngagementId: teId, stage: 'in_preparation', trelloCardId: 'card-r22', asOf: BUNDLE_DATE });
  const defaults = await applyNewReturnDefaults(app, teId, contactId);
  assert.equal(defaults.preparerId, rene.id, 'the imported return is assigned, so it is in somebody’s queue');

  const { rows } = await app.db.query<{ preparer_id: string | null; stage: string }>(
    `SELECT preparer_id, stage::text AS stage FROM tax_engagements WHERE id = $1`, [teId]
  );
  assert.equal(rows[0]!.preparer_id, rene.id);
  assert.equal(rows[0]!.stage, 'in_preparation');
});

test('R22: the defaults run AFTER the imported stage, because a standing letter would trip the freshness check', async () => {
  /*
   * THE ORDER IS LOAD-BEARING. applyNewReturnDefaults inherits a letter the CLIENT ACTUALLY SIGNED
   * onto every return it covers — a real fact, not a fabrication — and setImportedStage refuses a
   * return that already carries any gate fact. Defaults first would make the import refuse itself on
   * exactly the clients who are furthest along.
   */
  await deactivateAllPreparers();
  await makeStaff(app.db, config, {
    email: 'preparer-order@example.test', name: 'Synthetic Preparer', role: 'tax_preparer', password: 'prep-password-1234567',
  });
  const { teId, contactId } = await freshReturn({ letterSigned: true });

  // The order the importer uses: stage, then defaults. Both succeed.
  await setImportedStage(app, actor, { taxEngagementId: teId, stage: 'ready_to_file', trelloCardId: 'card-order', asOf: BUNDLE_DATE });
  const defaults = await applyNewReturnDefaults(app, teId, contactId);
  assert.equal(defaults.engagementLetterInherited, true, 'the standing letter was inherited');

  // The other order would have refused. Proven on a second return rather than argued.
  const second = await freshReturn({ letterSigned: true });
  await applyNewReturnDefaults(app, second.teId, second.contactId);
  await assert.rejects(
    () => setImportedStage(app, actor, { taxEngagementId: second.teId, stage: 'ready_to_file', trelloCardId: 'card-order-2', asOf: BUNDLE_DATE }),
    /not_a_fresh_import|already records/i,
    'defaults-then-stage is refused, which is why the importer does it the other way round'
  );
});

test('R22: SEVERAL active preparers is not a refusal — the firm chooses, not the import', async () => {
  await deactivateAllPreparers();
  await makeStaff(app.db, config, { email: 'prep-a@example.test', name: 'Synthetic A', role: 'tax_preparer', password: 'prep-password-1234567' });
  await makeStaff(app.db, config, { email: 'prep-b@example.test', name: 'Synthetic B', role: 'tax_preparer', password: 'prep-password-1234567' });

  const pre = await assertImportPreconditions(app);
  assert.equal(pre.activePreparers, 2, 'it proceeds');
  assert.equal(pre.defaultPreparerId, null, 'and applies no default, so nobody is assigned by guess');

  const { teId, contactId } = await freshReturn();
  const defaults = await applyNewReturnDefaults(app, teId, contactId);
  assert.equal(defaults.preparerId, null, 'the return lands unassigned and the count is reported');
});

// ── R23: AT OR PAST FILED ──────────────────────────────────────────────────

test('R23: "filed, awaiting ack" declares the address default, method e-file, FLAGGED as a default', async () => {
  const { teId } = await freshReturn({ state: 'IL' });
  await setImportedStage(app, actor, { taxEngagementId: teId, stage: 'filed', trelloCardId: 'card-ack', asOf: BUNDLE_DATE });

  const got = await declareImportedJurisdictions(app, actor, { taxEngagementId: teId, trelloCardId: 'card-ack', asOf: BUNDLE_DATE });
  assert.ok(got.jurisdictions.includes('federal'), 'federal is always declared');
  assert.ok(got.jurisdictions.includes('IL'), 'and the state the address implies');
  assert.equal(got.filingMethod, 'efile', 'a current year is the e-file lane (R31: the method is the year’s)');

  const { rows } = await app.db.query<{ jurisdiction: string; filing_method: string; flagged: boolean; accepted_on: string | null }>(
    `SELECT jurisdiction, filing_method, declared_by_import_default AS flagged, accepted_on
       FROM tax_engagement_jurisdictions WHERE tax_engagement_id = $1 ORDER BY jurisdiction`,
    [teId]
  );
  assert.equal(rows.length, got.jurisdictions.length);
  for (const r of rows) {
    assert.equal(r.filing_method, 'efile', 'method e-file (R23)');
    assert.equal(r.flagged, true, 'FLAGGED: this is a default, not a preparer’s declaration');
    assert.equal(r.accepted_on, null, 'and no acceptance is invented');
  }

  const audit = await app.db.query<{ n: number; declared_by: string }>(
    `SELECT count(*)::int AS n, min(details->>'declared_by') AS declared_by FROM audit_log
      WHERE action = 'tax_engagement.jurisdictions_declared_by_import_default' AND object_id = $1`,
    [teId]
  );
  assert.equal(audit.rows[0]!.n, 1, 'one audit row says so');
  assert.equal(audit.rows[0]!.declared_by, 'import default');
});

test('R23: a state with no income tax gets federal alone, because the default is the app’s own', async () => {
  const { teId } = await freshReturn({ state: 'TX' });
  await setImportedStage(app, actor, { taxEngagementId: teId, stage: 'filed', trelloCardId: 'card-tx', asOf: BUNDLE_DATE });
  const got = await declareImportedJurisdictions(app, actor, { taxEngagementId: teId, trelloCardId: 'card-tx', asOf: BUNDLE_DATE });
  assert.deepEqual(got.jurisdictions, ['federal'], 'no Texas income-tax filing is declared');
});

test('R31: an OLD year declares PAPER by the year’s lane, flagged, with NO mailing invented', async () => {
  /*
   * CLAUDE.md, non-negotiable: "Never route an old year to e-file." R23 first met that rule by
   * refusing any paper-lane card; R31 amends it: the method is derived from the year, the same way
   * Mark filed and migration 0113 derive it, so an old year is declared PAPER — never e-file, and
   * never turned away. And nothing about a mailing is written: the card said "filed", not when or how.
   */
  const { teId } = await freshReturn({ year: 2018, state: 'IL' });
  await setImportedStage(app, actor, { taxEngagementId: teId, stage: 'filed', trelloCardId: 'card-old', asOf: BUNDLE_DATE });
  const got = await declareImportedJurisdictions(app, actor, { taxEngagementId: teId, trelloCardId: 'card-old', asOf: BUNDLE_DATE });
  assert.equal(got.filingMethod, 'paper', 'the lane the year implies');
  assert.ok(got.jurisdictions.includes('federal') && got.jurisdictions.includes('IL'), 'the same address default as the e-file lane');

  const { rows } = await app.db.query<{
    jurisdiction: string; filing_method: string; flagged: boolean; mailed_on: string | null; mailing_method: string | null; tracking: string | null; accepted_on: string | null;
  }>(
    `SELECT jurisdiction, filing_method, declared_by_import_default AS flagged, mailed_on, mailing_method, tracking_number AS tracking, accepted_on
       FROM tax_engagement_jurisdictions WHERE tax_engagement_id = $1 ORDER BY jurisdiction`,
    [teId]
  );
  assert.equal(rows.length, got.jurisdictions.length, 'every jurisdiction on the list has a row');
  for (const r of rows) {
    assert.equal(r.filing_method, 'paper', `${r.jurisdiction}: PAPER, never e-file for an old year`);
    assert.equal(r.flagged, true, `${r.jurisdiction}: flagged as a default, exactly as the e-file lane is`);
    assert.equal(r.mailed_on, null, `${r.jurisdiction}: no mailing date invented`);
    assert.equal(r.mailing_method, null, `${r.jurisdiction}: no mailing method invented`);
    assert.equal(r.tracking, null, `${r.jurisdiction}: no tracking number invented`);
    assert.equal(r.accepted_on, null, `${r.jurisdiction}: no acceptance invented`);
  }
  const audit = await app.db.query<{ method: string; mailing: string }>(
    `SELECT details->>'filing_method' AS method, details->>'mailing_recorded' AS mailing FROM audit_log
      WHERE action = 'tax_engagement.jurisdictions_declared_by_import_default' AND object_id = $1`,
    [teId]
  );
  assert.equal(audit.rows.length, 1, 'one audit row');
  assert.equal(audit.rows[0]!.method, 'paper', 'and it says paper');
  assert.equal(audit.rows[0]!.mailing, 'false', 'and that no mailing was recorded');
});

test('R31: the boundary of the lane is the app’s own — the oldest e-file year is e-file, one older is paper', async () => {
  const currentTaxYear = new Date().getFullYear() - 1;
  const oldestEfile = currentTaxYear - 2;
  const a = await freshReturn({ year: oldestEfile, state: 'IL' });
  await setImportedStage(app, actor, { taxEngagementId: a.teId, stage: 'filed', trelloCardId: 'card-edge-a', asOf: BUNDLE_DATE });
  const ga = await declareImportedJurisdictions(app, actor, { taxEngagementId: a.teId, trelloCardId: 'card-edge-a', asOf: BUNDLE_DATE });
  assert.equal(ga.filingMethod, 'efile', `${oldestEfile} is still current + 2 prior`);

  const b = await freshReturn({ year: oldestEfile - 1, state: 'IL' });
  await setImportedStage(app, actor, { taxEngagementId: b.teId, stage: 'filed', trelloCardId: 'card-edge-b', asOf: BUNDLE_DATE });
  const gb = await declareImportedJurisdictions(app, actor, { taxEngagementId: b.teId, trelloCardId: 'card-edge-b', asOf: BUNDLE_DATE });
  assert.equal(gb.filingMethod, 'paper', `${oldestEfile - 1} is the paper lane`);
});

test('R23: "accepted, client not yet notified" and "paper filed" import as completed with NOTHING invented', async () => {
  for (const shape of ['accepted, client not yet notified', 'paper filed'] as const) {
    const { teId } = await freshReturn({ state: 'IL' });
    await setImportedStage(app, actor, { taxEngagementId: teId, stage: 'completed', trelloCardId: `card-${shape.slice(0, 6)}`, asOf: BUNDLE_DATE });

    const { rows } = await app.db.query<{
      stage: string; filed: string | null; fed: string | null; st: string | null; efile: string | null; juris: number; doc: string | null;
    }>(
      `SELECT te.stage::text AS stage, te.filed_date AS filed, te.federal_accepted_on AS fed,
              te.state_accepted_on AS st, te.efile_accepted_at AS efile, te.f8879_document_id AS doc,
              (SELECT count(*)::int FROM tax_engagement_jurisdictions j WHERE j.tax_engagement_id = te.id) AS juris
         FROM tax_engagements te WHERE te.id = $1`,
      [teId]
    );
    const r = rows[0]!;
    assert.equal(r.stage, 'completed', `${shape}: completed under the attestation`);
    assert.equal(r.fed, null, `${shape}: no federal acceptance invented`);
    assert.equal(r.st, null, `${shape}: no state acceptance invented`);
    assert.equal(r.efile, null, `${shape}: no e-file acceptance timestamp invented`);
    assert.equal(r.juris, 0, `${shape}: no jurisdiction row, so no mailing and no ack is claimed`);
    assert.equal(r.doc, null, `${shape}: no 8879 document`);
    assert.equal(r.filed, null, `${shape}: the card never said when it went out`);

    const att = await app.db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_log WHERE action = 'tax_engagement.imported_at_stage' AND object_id = $1`,
      [teId]
    );
    assert.equal(att.rows[0]!.n, 1, `${shape}: one attestation, which is the only thing asserting the history`);
  }
});

test('R23: a business return declares the ENTITY’s state, not the contact’s', async () => {
  seq++;
  const c = await makeContact(app.db, { firstName: 'Entity', lastName: `Owner${seq}`, email: `entity.owner${seq}@example.test` });
  await app.db.query(`UPDATE contacts SET state = 'IL' WHERE id = $1`, [c.id]);
  const businessId = await businessFor(app.db, c.id);
  await app.db.query(`UPDATE businesses SET state = 'DE' WHERE id = $1`, [businessId]);
  const eng = await app.db.query<{ id: string }>(
    `INSERT INTO engagements (contact_id, business_id, service_line, title, status) VALUES ($1, $2, 'tax', 'imported 1120S', 'active') RETURNING id`,
    [c.id, businessId]
  );
  const te = await app.db.query<{ id: string }>(
    `INSERT INTO tax_engagements (engagement_id, tax_year, return_type, client_type) VALUES ($1, 2025, '1120s', 'business') RETURNING id`,
    [eng.rows[0]!.id]
  );
  const teId = te.rows[0]!.id;
  await setImportedStage(app, actor, { taxEngagementId: teId, stage: 'filed', trelloCardId: 'card-biz', asOf: BUNDLE_DATE });
  const got = await declareImportedJurisdictions(app, actor, { taxEngagementId: teId, trelloCardId: 'card-biz', asOf: BUNDLE_DATE });
  assert.ok(got.jurisdictions.includes('DE'), `the entity's state, got ${got.jurisdictions.join(', ')}`);
  assert.ok(!got.jurisdictions.includes('IL'), 'not the owner’s');
});

// ── R33: SALES-TAX AND PAYROLL FACTS LAND ON AN ENGAGEMENT ─────────────────

const FACT_ACTOR_LABEL = 'trello import rehearsal (synthetic), applied by script';
let factActor: AuthedStaff | null = null;
async function importer(): Promise<AuthedStaff> {
  if (factActor) return factActor;
  const { rows } = await app.db.query<{ id: string; email: string; display_name: string; role_key: string }>(
    `SELECT s.id, s.email, s.display_name, r.key AS role_key FROM staff s JOIN roles r ON r.id = s.role_id WHERE s.id = $1`, [ceoId]
  );
  const s = rows[0]!;
  factActor = { id: s.id, email: s.email, fullName: `${s.display_name} (${FACT_ACTOR_LABEL})`, roleKey: s.role_key, permissions: [], sessionId: 'synthetic' };
  return factActor;
}
let factSeq = 0;
/** A business with a primary member, the shape a matched 04b row resolves to. */
async function clientBusiness(): Promise<{ contactId: string; businessId: string }> {
  factSeq++;
  const c = await makeContact(app.db, { firstName: 'Fact', lastName: `Owner${factSeq}`, email: `fact.owner${factSeq}@example.test` });
  const businessId = await businessFor(app.db, c.id);
  return { contactId: c.id, businessId };
}
async function engagementsOn(businessId: string, line: 'sales_tax' | 'payroll'): Promise<Array<{ id: string; status: string; period_key: string | null; filing_frequency: string | null; payroll_provider: string | null; source: string | null }>> {
  const { rows } = await app.db.query<{ id: string; status: string; period_key: string | null; filing_frequency: string | null; payroll_provider: string | null; source: string | null }>(
    `SELECT id, status::text AS status, period_key, filing_frequency, payroll_provider, source::text AS source
       FROM engagements WHERE business_id = $1 AND service_line = $2::service_line ORDER BY created_at`,
    [businessId, line]
  );
  return rows;
}
async function ledgerRow(sourceId: string, factType: string): Promise<{ rows_written: number; business_id: string | null } | null> {
  const { rows } = await app.db.query<{ rows_written: number; business_id: string | null }>(
    `SELECT rows_written, business_id FROM service_fact_imports WHERE source = 'trello' AND trello_source_id = $1 AND fact_type = $2`,
    [sourceId, factType]
  );
  return rows[0] ?? null;
}
const factInput = (over: Partial<Parameters<typeof applyRecurringServiceFact>[2]>): Parameters<typeof applyRecurringServiceFact>[2] => ({
  factType: 'sales_tax', sourceId: 'src-unset', matchKey: 'FACT KEY', asOf: BUNDLE_DATE, appliedBy: FACT_ACTOR_LABEL,
  sourceTag: 'trello_2026-09-19', contactId: '', businessId: null, values: {}, ...over,
});

test('R33: a live sales-tax fact creates ONE active sales_tax engagement carrying the filing frequency, and a second run does nothing', async () => {
  const { contactId, businessId } = await clientBusiness();
  const values = { frequency: 'monthly', closed_or_not_client: false, last_period_label: ['ST-1 AUG 2026 DONE'] };
  const first = await applyRecurringServiceFact(app, await importer(), factInput({ sourceId: 'st-1', contactId, businessId, values }));
  assert.equal(first.outcome, 'applied');
  assert.equal(first.engagementCreated, true, 'no sales_tax engagement existed, so one was made');
  assert.equal(first.rowsWritten, 2, 'the engagement and the column');

  const engs = await engagementsOn(businessId, 'sales_tax');
  assert.equal(engs.length, 1);
  assert.equal(engs[0]!.status, 'active');
  assert.equal(engs[0]!.period_key, 'ongoing', 'a recurring line’s period (engagements/period.ts)');
  assert.equal(engs[0]!.filing_frequency, 'monthly', '0106’s column, on the engagement it is scoped to');
  assert.equal(engs[0]!.source, 'trello', 'provenance on the row (0111)');
  const led = await ledgerRow('st-1', 'sales_tax');
  assert.ok(led, 'the ledger row is the record of having applied it');
  assert.equal(led.rows_written, 2);
  assert.equal(led.business_id, businessId);

  // THE SECOND PASS. Same row, same key: the ledger answers before anything is read.
  const again = await applyRecurringServiceFact(app, await importer(), factInput({ sourceId: 'st-1', contactId, businessId, values }));
  assert.equal(again.outcome, 'already_applied');
  assert.equal(again.rowsWritten, 0);
  assert.equal((await engagementsOn(businessId, 'sales_tax')).length, 1, 'still one engagement');
});

test('R33: the frequency the bundle spells "quarterly-or-annual" is kept as 0106’s unresolved member, and an unknown one is refused', async () => {
  assert.equal(normalizeFilingFrequency('quarterly-or-annual'), 'quarterly_or_annual');
  assert.equal(normalizeFilingFrequency(' Annual '), 'annual');
  assert.equal(normalizeFilingFrequency('biweekly'), null);

  const { contactId, businessId } = await clientBusiness();
  const actorForBad = await importer();
  await assert.rejects(
    () => applyRecurringServiceFact(app, actorForBad, factInput({ sourceId: 'st-bad', contactId, businessId, values: { frequency: 'biweekly', closed_or_not_client: false } })),
    (err: unknown) => { assert.equal((err as { code?: string }).code, 'unknown_filing_frequency'); return true; }
  );
  assert.equal((await engagementsOn(businessId, 'sales_tax')).length, 0, 'nothing created on the way out');
  assert.equal(await ledgerRow('st-bad', 'sales_tax'), null, 'and no ledger row, so a corrected bundle can apply it');
});

test('R33: a CLOSED service creates nothing, and is still applied so the second pass finds it', async () => {
  const { contactId, businessId } = await clientBusiness();
  const values = { frequency: 'monthly', closed_or_not_client: true, last_period_label: ['CLOSED-ACCOUNT'] };
  assert.equal(isLiveServiceFact('sales_tax', values), false);
  const got = await applyRecurringServiceFact(app, await importer(), factInput({ sourceId: 'st-closed', contactId, businessId, values }));
  assert.equal(got.outcome, 'closed');
  assert.equal(got.engagementId, null);
  assert.equal(got.rowsWritten, 0);
  assert.equal((await engagementsOn(businessId, 'sales_tax')).length, 0, 'no engagement for a service the card says is closed');
  const led = await ledgerRow('st-closed', 'sales_tax');
  assert.ok(led, 'read and understood: a ledger row');
  assert.equal(led.rows_written, 0, 'that says nothing was written');

  const payrollClosed = { provider: 'QBO Payroll', closed_or_none: true, last_period_label: ['NO PAYROLL FOR NOW'] };
  assert.equal(isLiveServiceFact('payroll', payrollClosed), false);
  const p = await applyRecurringServiceFact(app, await importer(), factInput({ factType: 'payroll', sourceId: 'pr-closed', contactId, businessId, values: payrollClosed }));
  assert.equal(p.outcome, 'closed');
  assert.equal((await engagementsOn(businessId, 'payroll')).length, 0, 'a named provider on a closed payroll is not a live payroll');
});

test('R33: a payroll fact creates a payroll engagement with its provider; a blank provider is an engagement with none, not a placeholder', async () => {
  const a = await clientBusiness();
  const withProvider = await applyRecurringServiceFact(app, await importer(), factInput({
    factType: 'payroll', sourceId: 'pr-1', contactId: a.contactId, businessId: a.businessId,
    values: { provider: 'QBO Payroll', closed_or_none: false, last_period_label: ['Q2- 2025 PAYROLL FILED'] },
  }));
  assert.equal(withProvider.outcome, 'applied');
  assert.equal(withProvider.rowsWritten, 2);
  const ea = await engagementsOn(a.businessId, 'payroll');
  assert.equal(ea.length, 1);
  assert.equal(ea[0]!.payroll_provider, 'QBO Payroll', '0107’s column');
  assert.equal(ea[0]!.filing_frequency, null, 'and 0106’s column stays off a payroll line');

  const b = await clientBusiness();
  const blank = await applyRecurringServiceFact(app, await importer(), factInput({
    factType: 'payroll', sourceId: 'pr-2', contactId: b.contactId, businessId: b.businessId,
    values: { provider: '', closed_or_none: false, last_period_label: ['PAYROLL JUST STARTED'] },
  }));
  assert.equal(blank.outcome, 'applied');
  assert.equal(blank.rowsWritten, 1, 'the engagement alone');
  const eb = await engagementsOn(b.businessId, 'payroll');
  assert.equal(eb.length, 1);
  assert.equal(eb[0]!.payroll_provider, null, 'NULL, which 0107 reads as "not recorded" — never a blank the CHECK would refuse');
});

test('R33: a value a person already set is never overwritten, and an existing live engagement is used rather than doubled', async () => {
  const { contactId, businessId } = await clientBusiness();
  const existing = await app.db.query<{ id: string }>(
    `INSERT INTO engagements (contact_id, business_id, service_line, status, title, period_key, filing_frequency)
     VALUES ($1, $2, 'sales_tax', 'active', 'set by a person', 'ongoing', 'annual') RETURNING id`,
    [contactId, businessId]
  );
  const got = await applyRecurringServiceFact(app, await importer(), factInput({
    sourceId: 'st-existing', contactId, businessId, values: { frequency: 'monthly', closed_or_not_client: false },
  }));
  assert.equal(got.outcome, 'applied');
  assert.equal(got.engagementCreated, false, 'the live engagement was found');
  assert.equal(got.engagementId, existing.rows[0]!.id);
  assert.equal(got.rowsWritten, 0, 'and nothing changed: the person’s value stands');
  const engs = await engagementsOn(businessId, 'sales_tax');
  assert.equal(engs.length, 1, 'one engagement, not two (0098’s index would refuse two anyway)');
  assert.equal(engs[0]!.filing_frequency, 'annual', 'the card did not overrule the person');
  const led = await ledgerRow('st-existing', 'sales_tax');
  assert.ok(led && led.rows_written === 0, 'applied, 0 written — the two questions stay separate');
});

test('R33: a sole proprietor’s fact hangs on the CONTACT with no entity, and the ledger carries no business', async () => {
  factSeq++;
  const c = await makeContact(app.db, { firstName: 'Sole', lastName: `Prop${factSeq}`, email: `sole.prop${factSeq}@example.test` });
  const got = await applyRecurringServiceFact(app, await importer(), factInput({
    sourceId: 'st-sole', contactId: c.id, businessId: null, values: { frequency: 'quarterly', closed_or_not_client: false },
  }));
  assert.equal(got.outcome, 'applied');
  assert.equal(got.engagementCreated, true);
  const { rows } = await app.db.query<{ n: number; freq: string | null }>(
    `SELECT count(*)::int AS n, min(filing_frequency) AS freq FROM engagements
      WHERE contact_id = $1 AND business_id IS NULL AND service_line = 'sales_tax' AND status = 'active'`,
    [c.id]
  );
  assert.equal(rows[0]!.n, 1);
  assert.equal(rows[0]!.freq, 'quarterly');
  const led = await ledgerRow('st-sole', 'sales_tax');
  assert.ok(led && led.business_id === null);
});
