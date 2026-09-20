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
 *   R23  "filed, awaiting ack" declares the R2 address default, method e-file, every row FLAGGED as
 *        a default; "accepted, client not yet notified" and "paper filed" import as completed with
 *        no acceptance row invented. And an old year is refused rather than routed to e-file.
 *
 * Synthetic data only.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import { createTestConfig, makeContact, makeStaff, businessFor } from './helpers.ts';
import type { Config } from '../src/config.ts';
import { assertImportPreconditions, declareImportedJurisdictions, setImportedStage } from '../src/modules/tax/import.ts';
import { applyNewReturnDefaults } from '../src/modules/tax/pipeline.ts';

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

test('R23: an OLD year is refused rather than routed to e-file', async () => {
  /*
   * CLAUDE.md, non-negotiable: "Never route an old year to e-file." R23 says the method is e-file,
   * which is right for a pending ack and wrong for a year in the paper lane. Rather than pick between
   * a ruling and a hard rule, the service refuses and the importer makes it a preparer task.
   */
  const { teId } = await freshReturn({ year: 2018, state: 'IL' });
  await setImportedStage(app, actor, { taxEngagementId: teId, stage: 'filed', trelloCardId: 'card-old', asOf: BUNDLE_DATE });
  await assert.rejects(
    () => declareImportedJurisdictions(app, actor, { taxEngagementId: teId, trelloCardId: 'card-old', asOf: BUNDLE_DATE }),
    (err: unknown) => {
      const e = err as { code?: string; message?: string };
      assert.equal(e.code, 'old_year_is_paper_lane');
      assert.match(e.message ?? '', /never route an old year to e-file/i);
      return true;
    }
  );
  const { rows } = await app.db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM tax_engagement_jurisdictions WHERE tax_engagement_id = $1`, [teId]
  );
  assert.equal(rows[0]!.n, 0, 'and nothing was declared on the way out');
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
