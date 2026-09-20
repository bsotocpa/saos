/*
 * TRELLO IMPORT — THE SEND-SUPPRESSION PROOF (Brian, 2026-09-19, item 15). COPY ONLY.
 *
 * THE QUESTION. Seven client-acting automations are armed on production. Phase 2 will create
 * engagements, returns at accepted stages, and a billing worklist — and every one of those is an
 * event the live system already knows how to tell a client about. So: does importing a return
 * that is ALREADY accepted enqueue an outbound message to that client? The answer has to be a
 * COUNT, taken before and after, on a copy of production with the same seven toggles armed —
 * not a reading of the code, because the code is what we are checking.
 *
 * WHERE THIS RUNS. `saos_trello_copy`, a pg_dump copy of production in the same Postgres
 * container, made the way scripts/preflight-migrate.sh makes `<db>_preflight`. The copy is
 * DROPPED at the end of the exercise. assertCopyDatabase() refuses any database whose name does
 * not end in `_copy`, so this script cannot be pointed at production by a slip of the shell.
 *
 * THE DOORS IT USES, and it uses no others:
 *   createEngagement   (modules/engagements/service.ts)  — the parent engagement
 *   the tax-engagement INSERT that modules/tax/routes.ts uses — there is no service wrapper
 *   transitionStage    (modules/tax/pipeline.ts)         — every stage move, gates and all
 *   recordSigned8879   (modules/tax/signed-8879.ts)      — the authorization gate's own door
 *   createTask         (modules/tasks/service.ts)        — file 02, never a raw INSERT
 *
 * TWO PHASES, and the difference between them is the finding:
 *
 *   PHASE A — THE HONEST IMPORT. Create the engagement and the return, then walk toward the
 *   mapped stage through transitionStage with NOTHING stamped. This is what Phase 2 would
 *   actually do, and it stops at the first compliance gate, which is the point.
 *
 *   PHASE B — THE GATE REHEARSAL (REHEARSE_GATES=1). To measure the outbox at 'filed' — the only
 *   place on this path where a client send can be enqueued — the gates have to be satisfied.
 *   This phase stamps the engagement letter and the estimate lock, writes a signed-authorization
 *   document row and passes it through recordSigned8879, names a PTIN holder, and then walks
 *   filed → completed. EVERY ONE OF THOSE STAMPS IS A FACT PHASE 2 MUST NOT INVENT. They exist
 *   here only so the count at 'filed' is a real count, on a database that is about to be dropped.
 *
 * Nothing drains the outbox. If a row is enqueued it STAYS enqueued and is counted; the copy is
 * discarded rather than flushed (Brian's instruction).
 *
 *   DATABASE_URL=postgresql://…/saos_trello_copy \
 *     node --experimental-strip-types scripts/trello-import.ts [--dir …] [--limit 6]
 *   REHEARSE_GATES=1 … same command                       — also walks filed → completed
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildServer } from '../src/server.ts';
import { loadConfig } from '../src/config.ts';
import { parseCsvObjects } from '../src/migration/csv.ts';
import { createEngagement } from '../src/modules/engagements/service.ts';
import { transitionStage, type TaxStage } from '../src/modules/tax/pipeline.ts';
import { recordSigned8879 } from '../src/modules/tax/signed-8879.ts';
import { createTask } from '../src/modules/tasks/service.ts';
import { createSession } from '../src/modules/auth/service.ts';
import { ownerForRole, alertRecipientForRole } from '../src/staffing.ts';
import { assertCopyDatabase, contactNorm, trelloKey } from './trello-normalize.ts';

const argv = process.argv.slice(2);
const arg = (name: string, dflt: string): string => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? (argv[i + 1] ?? dflt) : dflt;
};
const DIR = resolve(arg('dir', '/opt/saos/imports/trello_import'));
const LOGS = resolve(DIR, 'logs');
const LIMIT = Number(arg('limit', '25'));
const REHEARSE = process.env.REHEARSE_GATES === '1';
const SOURCE_TAG = 'trello_2026-09-19';

const config = loadConfig();
const dbName = assertCopyDatabase(config.DATABASE_URL);
mkdirSync(LOGS, { recursive: true });

const app = buildServer(config, {});
await app.ready();

/** Outbox and audit, by status, at a moment. The whole exercise is the difference between two of these. */
async function snapshot(): Promise<{ outbox: number; pending: number; audit: number; tasks: number; byEffect: string }> {
  const o = await app.db.query<{ n: string; pending: string }>(
    `SELECT count(*) AS n, count(*) FILTER (WHERE status IN ('pending', 'failed')) AS pending FROM outbox`
  );
  const a = await app.db.query<{ n: string }>(`SELECT count(*) AS n FROM audit_log`);
  const t = await app.db.query<{ n: string }>(`SELECT count(*) AS n FROM tasks`);
  const e = await app.db.query<{ effect: string; n: string }>(
    `SELECT effect, count(*)::text AS n FROM outbox GROUP BY effect ORDER BY effect`
  );
  return {
    outbox: Number(o.rows[0]!.n),
    pending: Number(o.rows[0]!.pending),
    audit: Number(a.rows[0]!.n),
    tasks: Number(t.rows[0]!.n),
    byEffect: e.rows.map((r) => `${r.effect}=${r.n}`).join(' ') || '(none)',
  };
}

// ── the labelled session: every audit row names the script ──────────────────

const ceoRow = await app.db.query<{ id: string; email: string; display_name: string; role_key: string }>(
  `SELECT st.id, st.email, st.display_name, r.key AS role_key
     FROM staff st JOIN roles r ON r.id = st.role_id
    WHERE r.key = 'ceo' AND st.is_active ORDER BY st.created_at LIMIT 1`
);
if (!ceoRow.rows[0]) throw new Error('refusing: no active CEO on the copy');
const ceo = ceoRow.rows[0];
const APPLIED_BY = 'trello import phase-1 rehearsal 2026-09-19, applied by script';
await createSession(app.db, config, ceo.id, { appliedBy: APPLIED_BY });
const sessionId = (
  await app.db.query<{ id: string }>(
    `SELECT id FROM staff_sessions WHERE staff_id = $1 ORDER BY created_at DESC LIMIT 1`, [ceo.id]
  )
).rows[0]!.id;
const perms = await app.db.query<{ permission: string }>(
  `SELECT rp.permission FROM role_permissions rp JOIN roles r ON r.id = rp.role_id JOIN staff st ON st.role_id = r.id WHERE st.id = $1`,
  [ceo.id]
);
const actorStaff = {
  id: ceo.id, email: ceo.email, fullName: `${ceo.display_name} (${APPLIED_BY})`,
  roleKey: ceo.role_key, permissions: perms.rows.map((r) => r.permission), sessionId,
};
/** The shape transitionStage and recordSigned8879 want. Same label, so the audit rows agree. */
const actorLabel = { staffId: ceo.id, label: actorStaff.fullName };

console.log(`trello-import: database '${dbName}', bundle ${DIR}, limit ${LIMIT}, rehearse gates ${REHEARSE ? 'ON' : 'off'}`);
console.log(`  labelled session ${sessionId.slice(0, 8)} — every audit row reads "${APPLIED_BY}"`);

// ── the rows this rehearsal touches ─────────────────────────────────────────

const load = (f: string): Array<Record<string, string>> => parseCsvObjects(readFileSync(resolve(DIR, f), 'utf8'));
const f01 = load('01_tax_wip.csv');
const f02 = load('02_tax_ar_worklist.csv');

/** The file-01 stages that map to an accepted/completed SAOS stage (item 12's map). */
const ACCEPTED_PLAIN = new Set(['accepted, client not yet notified', 'accepted, balance open', 'accepted and paid']);

const contacts = await app.db.query<{ id: string; first_name: string; last_name: string }>(
  `SELECT id, first_name, last_name FROM contacts
    WHERE NOT is_archived AND contact_status <> 'archived' AND NOT is_test`
);
const conByFull = new Map<string, string[]>();
for (const c of contacts.rows) {
  const k = contactNorm(`${c.first_name} ${c.last_name}`);
  if (!conByFull.has(k)) conByFull.set(k, []);
  conByFull.get(k)!.push(c.id);
}
const bizRows = await app.db.query<{ id: string; name: string }>(
  `SELECT id, name FROM businesses WHERE NOT is_archived AND NOT is_test`
);
const bizByKey = new Map<string, string[]>();
for (const b of bizRows.rows) {
  const k = trelloKey(b.name);
  if (!bizByKey.has(k)) bizByKey.set(k, []);
  bizByKey.get(k)!.push(b.id);
}

/**
 * A business return hangs off its primary member: an engagement needs a contact_id, and there is
 * nobody to bill or write to without one. Loaded up front so resolve() stays synchronous.
 */
const primaryMember = new Map<string, string>();
{
  const { rows } = await app.db.query<{ business_id: string; contact_id: string }>(
    `SELECT DISTINCT ON (business_id) business_id, contact_id FROM business_members ORDER BY business_id, is_primary DESC`
  );
  for (const r of rows) primaryMember.set(r.business_id, r.contact_id);
}

/** Only a unique exact normalized match is importable. Everything else is a person's decision. */
function resolve1(row: Record<string, string>): { contactId: string; businessId?: string } | null {
  const full = contactNorm((row.name_clean ?? '').trim());
  const hit = conByFull.get(full) ?? [];
  if (hit.length === 1) return { contactId: hit[0]! };
  const bizHit = bizByKey.get((row.match_key ?? '').trim()) ?? [];
  if (bizHit.length === 1) {
    const primary = primaryMember.get(bizHit[0]!);
    return primary ? { contactId: primary, businessId: bizHit[0]! } : null;
  }
  return null;
}

const RETURN_TYPES: Record<string, string> = {
  '1040': '1040', '1120-S': '1120s', '1120-C': '1120c', '1120': '1120', '1065': '1065',
  '990': '990', '990-N': '990ez', 'Schedule C': '1040',
};

const eligible = f01
  .filter((r) => ACCEPTED_PLAIN.has((r.proposed_stage_plain ?? '').trim()))
  .map((r) => ({ row: r, target: resolve1(r) }))
  .filter((x): x is { row: Record<string, string>; target: { contactId: string; businessId?: string } } => x.target !== null)
  .slice(0, LIMIT);

console.log(
  `  file 01: ${f01.filter((r) => ACCEPTED_PLAIN.has((r.proposed_stage_plain ?? '').trim())).length} row(s) at an accepted stage, ` +
    `${eligible.length} of them uniquely matched and importable`
);

// ── the counts, before ──────────────────────────────────────────────────────

const before = await snapshot();
console.log(`  BEFORE  outbox=${before.outbox} (pending/failed ${before.pending}) audit=${before.audit} tasks=${before.tasks}  effects: ${before.byEffect}`);
const armed = await app.db.query<{ key: string }>(`SELECT key FROM automations WHERE enabled ORDER BY key`);
console.log(`  armed automations on the copy (${armed.rows.length}): ${armed.rows.map((r) => r.key).join(', ')}`);

// ── PHASE A: the honest import ──────────────────────────────────────────────

const WALK: TaxStage[] = [
  'scheduled', 'documents_requested', 'in_preparation', 'internal_review',
  'client_review', 'ready_to_file', 'filed', 'completed',
];
interface Outcome { cardId: string; reached: TaxStage | 'intake_started'; blockedAt: string; blockedBy: string; taxEngagementId: string }
const outcomes: Outcome[] = [];

let engagementRefused = 0;
for (const { row, target } of eligible) {
  const year = 2025;
  const formType = (row.form_type ?? '').trim();
  const returnType = RETURN_TYPES[formType] ?? (target.businessId ? '1120s' : '1040');
  /*
   * THE DUPLICATE GUARD THAT ALREADY EXISTS. `periodKey` puts this engagement under migration
   * 0083's one-active-per-line-and-period unique index, so a client who already has an active 2025
   * tax engagement REFUSES a second one — which is the Phase 2 rerun guard for engagements,
   * enforced by the database rather than by the script remembering.
   */
  let parent: { id: string };
  try {
    parent = await createEngagement(app, actorStaff, {
      contactId: target.contactId,
      ...(target.businessId ? { businessId: target.businessId } : {}),
      serviceLine: 'tax',
      title: `${year} ${returnType.toUpperCase()}`,
      status: 'active',
      periodKey: String(year),
      origin: { via: 'staff', reason: `Trello import rehearsal (${SOURCE_TAG}), card ${row.trello_card_id}` },
    }, { ip: null, userAgent: `script: ${APPLIED_BY}` });
  } catch (err) {
    engagementRefused++;
    console.log(`  engagement refused: ${err instanceof Error ? err.message.slice(0, 110) : String(err)}`);
    continue;
  }
  const te = await app.db.query<{ id: string }>(
    `INSERT INTO tax_engagements (engagement_id, tax_year, return_type, client_type, preparer_id, reviewer_id)
     VALUES ($1, $2, $3::return_type, $4::tax_client_type, $5, $6) RETURNING id`,
    [parent.id, year, returnType, target.businessId ? 'business' : 'individual', null, null]
  );
  const teId = te.rows[0]!.id;
  await app.db.query(
    `INSERT INTO engagement_stage_history (tax_engagement_id, stage, changed_by_staff_id, waiting_on, note)
     VALUES ($1, 'intake_started', $2, 'staff', $3)`,
    [teId, ceo.id, `imported from Trello (${SOURCE_TAG})`]
  );

  let reached: TaxStage | 'intake_started' = 'intake_started';
  let blockedAt = '';
  let blockedBy = '';
  for (const to of WALK) {
    try {
      await transitionStage(app, actorLabel, teId, to, { note: `Trello import rehearsal (${SOURCE_TAG})` });
      reached = to;
    } catch (err) {
      blockedAt = to;
      blockedBy = err && typeof err === 'object' && 'code' in err ? String((err as { code: unknown }).code) : String(err);
      break;
    }
  }
  outcomes.push({ cardId: row.trello_card_id ?? '', reached, blockedAt, blockedBy, taxEngagementId: teId });
}

const afterA = await snapshot();
console.log(`\nPHASE A — the honest import, nothing stamped`);
for (const o of outcomes.slice(0, 3)) console.log(`  reached ${o.reached}, blocked entering ${o.blockedAt || '(none)'} by ${o.blockedBy || '—'}`);
const blockedTally = new Map<string, number>();
for (const o of outcomes) blockedTally.set(`${o.reached} -> ${o.blockedAt}: ${o.blockedBy}`, (blockedTally.get(`${o.reached} -> ${o.blockedAt}: ${o.blockedBy}`) ?? 0) + 1);
for (const [k, v] of blockedTally) console.log(`  ${v} return(s): ${k}`);
console.log(`  ${engagementRefused} engagement(s) refused by the one-active-per-line-and-period index (migration 0083)`);
console.log(`  AFTER A outbox=${afterA.outbox} (pending/failed ${afterA.pending}) audit=${afterA.audit} tasks=${afterA.tasks}  effects: ${afterA.byEffect}`);

// ── PHASE B: the gate rehearsal ─────────────────────────────────────────────

let afterB = afterA;
let rehearsed = 0;
let reachedFiled = 0;
let reachedCompleted = 0;
if (REHEARSE) {
  console.log(`\nPHASE B — the gate rehearsal. Every stamp below is a fact Phase 2 must NOT invent.`);
  for (const o of outcomes) {
    const info = await app.db.query<{ contact_id: string; tax_year: number }>(
      `SELECT e.contact_id, te.tax_year FROM tax_engagements te JOIN engagements e ON e.id = te.engagement_id WHERE te.id = $1`,
      [o.taxEngagementId]
    );
    const { contact_id: contactId, tax_year: taxYear } = info.rows[0]!;
    // Gate 1 and gate 2, stamped directly: there is no service door for "this was already signed".
    await app.db.query(
      `UPDATE tax_engagements
          SET engagement_letter_signed_at = COALESCE(engagement_letter_signed_at, now()),
              estimate_locked_at = COALESCE(estimate_locked_at, now()),
              estimated_fee_min_cents = COALESCE(estimated_fee_min_cents, 0),
              estimated_fee_max_cents = COALESCE(estimated_fee_max_cents, 0)
        WHERE id = $1`,
      [o.taxEngagementId]
    );
    // Gate 3 goes through its OWN door, which needs a Signed Authorizations document to exist.
    const doc = await app.db.query<{ id: string }>(
      `INSERT INTO documents (contact_id, tax_engagement_id, tax_year, category, filename, minio_bucket, minio_key, uploaded_by_type, uploaded_by_id, scan_status)
       VALUES ($1, $2, $3, 'signed_authorizations', $4, 'rehearsal', $5, 'staff', $6, 'clean') RETURNING id`,
      [contactId, o.taxEngagementId, taxYear, `8879-rehearsal-${o.taxEngagementId.slice(0, 8)}.pdf`, `rehearsal/${o.taxEngagementId}`, ceo.id]
    );
    await recordSigned8879(app, { staffId: ceo.id, label: actorStaff.fullName }, {
      taxEngagementId: o.taxEngagementId,
      documentId: doc.rows[0]!.id,
      signedOn: `${taxYear + 1}-04-01`,
      preparerPtinHolderId: ceo.id,
    });
    const now = await app.db.query<{ stage: TaxStage }>(`SELECT stage FROM tax_engagements WHERE id = $1`, [o.taxEngagementId]);
    let stage: TaxStage | 'intake_started' = now.rows[0]!.stage;
    const from = WALK.indexOf(stage as TaxStage);
    for (const to of WALK.slice(from + 1)) {
      try {
        await transitionStage(app, actorLabel, o.taxEngagementId, to, { note: `gate rehearsal (${SOURCE_TAG})`, preparerPtinHolderId: ceo.id });
        stage = to;
        if (to === 'filed') reachedFiled++;
        if (to === 'completed') reachedCompleted++;
      } catch (err) {
        console.log(`  still blocked entering ${to}: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`);
        break;
      }
    }
    if (stage === 'completed' || stage === 'filed') rehearsed++;
  }
  afterB = await snapshot();
  console.log(`  ${rehearsed} return(s) walked the gates; ${reachedFiled} reached filed, ${reachedCompleted} reached completed`);
  console.log(`  AFTER B outbox=${afterB.outbox} (pending/failed ${afterB.pending}) audit=${afterB.audit} tasks=${afterB.tasks}  effects: ${afterB.byEffect}`);
}

// ── file 02 through the task door ───────────────────────────────────────────

/*
 * FILE 02 IS A WORKLIST, NEVER AN INVOICE (Brian, 2026-09-19, item 14). Rows whose card says an
 * invoice was drafted and is waiting on Brian go to the CEO; every other row goes to the billing
 * role, resolved through its ALERT RECIPIENT so an unfilled role is a recorded fact that falls
 * back to the CEO rather than an unowned task. One createTask per row, keyed on the card id, so a
 * rerun creates nothing — createTask's own (source_type, source_id) dedupe is the rerun guard.
 */
const beforeTasks = await snapshot();
const comms = await alertRecipientForRole(app.db, 'comms_billing', 'trello_ar_worklist');
const ceoOwner = await ownerForRole(app.db, 'ceo');
let taskRows = 0;
let taskCeo = 0;
for (const row of f02.slice(0, LIMIT)) {
  const pendingCeo = (row.invoice_state ?? '').trim() === 'created_pending_ceo_review';
  const owner = pendingCeo ? ceoOwner : comms;
  const target = resolve1(row);
  await createTask(app, {
    title: `Trello AR worklist: ${pendingCeo ? 'invoice drafted, waiting on Brian' : 'accepted return with an open balance'} (card ${row.trello_card_id})`,
    description:
      `Imported from the Trello AR worklist (${SOURCE_TAG}).\n` +
      `Trello list: ${row.trello_list}. Invoice state on the card: ${row.invoice_state}. ` +
      `This is a WORKLIST ITEM, not an invoice — no invoice is created by the import.`,
    assignedStaffId: owner,
    ...(target ? { contactId: target.contactId } : {}),
    priority: 2,
    source: 'import',
    sourceType: 'trello_ar_worklist',
    sourceId: row.trello_card_id ?? '',
  });
  taskRows++;
  if (pendingCeo) taskCeo++;
}
const afterTasks = await snapshot();
console.log(`\nFILE 02 through createTask: ${taskRows} row(s) offered, ${taskCeo} to the CEO, ${taskRows - taskCeo} to comms_billing`);
console.log(`  tasks ${beforeTasks.tasks} -> ${afterTasks.tasks}; outbox ${beforeTasks.outbox} -> ${afterTasks.outbox}`);

// Rerun idempotence, proven rather than asserted: the same loop again, and the counts must not move.
for (const row of f02.slice(0, LIMIT)) {
  const pendingCeo = (row.invoice_state ?? '').trim() === 'created_pending_ceo_review';
  await createTask(app, {
    title: `Trello AR worklist: rerun (card ${row.trello_card_id})`,
    assignedStaffId: pendingCeo ? ceoOwner : comms,
    priority: 2, source: 'import', sourceType: 'trello_ar_worklist', sourceId: row.trello_card_id ?? '',
  });
}
const afterRerun = await snapshot();
console.log(`  RERUN of the same ${taskRows} row(s): tasks ${afterTasks.tasks} -> ${afterRerun.tasks} (createTask's (source_type, source_id) dedupe)`);

// ── file 03 is refused ──────────────────────────────────────────────────────

/** Brian's ruling: file 03 is an existence check. The script refuses it, in code, not in a comment. */
function refuseFile03(filename: string): void {
  if (/03_tax_completed_roster/.test(filename)) {
    throw new Error(`refusing: ${filename} is never imported — it is an existence check only (Brian, 2026-09-19, item 14).`);
  }
}
let file03 = 'NOT REFUSED — that is a build failure';
try { refuseFile03('03_tax_completed_roster.csv'); } catch (err) { file03 = err instanceof Error ? err.message : 'refused'; }
console.log(`  file 03: ${file03}`);

// ── the table ───────────────────────────────────────────────────────────────

const lines = [
  'moment | outbox rows | outbox pending or failed | audit rows | task rows | notes',
  `before the import | ${before.outbox} | ${before.pending} | ${before.audit} | ${before.tasks} | ${armed.rows.length} client-acting automations armed on the copy: ${armed.rows.map((r) => r.key).join(' ')}`,
  `after phase A (${outcomes.length} engagement(s) + return(s) created, ${engagementRefused} refused, no gate stamped) | ${afterA.outbox} | ${afterA.pending} | ${afterA.audit} | ${afterA.tasks} | every walk stopped at a compliance gate; outbox delta ${afterA.outbox - before.outbox}`,
];
if (REHEARSE) {
  lines.push(
    `after phase B (gates stamped, ${reachedFiled} reached filed, ${reachedCompleted} reached completed) | ${afterB.outbox} | ${afterB.pending} | ${afterB.audit} | ${afterB.tasks} | outbox delta ${afterB.outbox - afterA.outbox}; filed is the only hook on this path that can enqueue`
  );
}
lines.push(
  `after file 02 through createTask (${taskRows} row(s)) | ${afterTasks.outbox} | ${afterTasks.pending} | ${afterTasks.audit} | ${afterTasks.tasks} | outbox delta ${afterTasks.outbox - beforeTasks.outbox}; ${taskCeo} to the CEO, ${taskRows - taskCeo} to comms_billing`,
  `after a rerun of the same file 02 rows | ${afterRerun.outbox} | ${afterRerun.pending} | ${afterRerun.audit} | ${afterRerun.tasks} | task delta ${afterRerun.tasks - afterTasks.tasks}`,
  `TOTAL DELTA | ${afterRerun.outbox - before.outbox} | ${afterRerun.pending - before.pending} | ${afterRerun.audit - before.audit} | ${afterRerun.tasks - before.tasks} | outbox effects at the end: ${afterRerun.byEffect}`
);
writeFileSync(resolve(LOGS, 'send-suppression.log'), lines.join('\n') + '\n');
console.log('\n' + lines.join('\n'));

await app.close();
process.exit(0);
