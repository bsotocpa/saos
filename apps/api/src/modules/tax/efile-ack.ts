/*
 * E-FILE ACKNOWLEDGMENT AUTOMATION (2026-09-12, Brian's ruling).
 *
 * Laura, offshore, used to read the ATX acknowledgment report by hand and email each client
 * that the IRS or the state had accepted their return. That duty leaves her. This is what
 * replaces it, and the shape is deliberate:
 *
 *   UPLOAD   Ana-Maria uploads the report. It is stored verbatim, hashed, and parsed. The parser
 *            reads columns by NAME with a small alias table; a report whose required columns
 *            cannot be found is refused whole, never guessed at.
 *   MATCH    Each row is matched to exactly one SAOS return by (tax year, return type, client).
 *            Zero candidates, two candidates, or a jurisdiction already acknowledged for that
 *            return is NOT a match — it is a task to the tax preparer naming the row and why.
 *   DISPOSE  accepted + matched  → queued for the client, and the return records the date
 *            rejected + matched  → the existing owned reject path (task + perfection clock);
 *                                  never a client email
 *            anything else       → a task, with the reason on it
 *   REVIEW   Nothing sends on upload. The review screen lists what WILL send; Ana-Maria can
 *            hold any row. Release is a separate, explicit step. Required, not optional — see
 *            the note on releaseReport.
 *   SEND     Released rows become outbox effects. The handler is gated by the
 *            efile_acknowledgment automation (ships OFF; Brian arms it), EN/ES by the client's
 *            language, federal and state as two different messages.
 *
 * NO SSN IS STORED. ATX exports carry a taxpayer id; the parser keeps at most the last four
 * digits in memory for matching and writes only the outcome.
 */
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { AppError } from '../../types.ts';
import { writeAudit } from '../../audit.ts';
import { parseCsvObjects } from '../../migration/csv.ts';
import { createTask } from '../tasks/service.ts';
import { ownerForRole } from '../../staffing.ts';
import { isAutomationEnabled } from '../../automations.ts';
import { enqueueEffect } from '../../outbox.ts';
import { sendTemplatedEmail } from '../templates/service.ts';
import { recordEfileResult } from './pipeline.ts';

export type Jurisdiction = 'federal' | 'state';
export type AckStatus = 'accepted' | 'rejected' | 'other';

export interface ParsedAckRow {
  rowIndex: number;
  clientName: string;
  taxYear: number | null;
  returnType: string | null;
  jurisdiction: Jurisdiction;
  stateCode: string | null;
  status: AckStatus;
  statusRaw: string;
  submissionId: string | null;
  acknowledgedOn: string | null;
  rejectCode: string | null;
  rejectReason: string | null;
  /** In memory only. Never written. */
  taxpayerLast4: string | null;
}

/*
 * ATX names its columns differently across report types and versions. These are the names seen
 * in the acknowledgment / e-file status exports; a header is matched case-insensitively after
 * stripping punctuation. If a REQUIRED column has no match the whole report is refused with the
 * headers it did find, so the person can see what ATX actually produced.
 */
const COLUMN_ALIASES: Record<string, string[]> = {
  clientName: ['client name', 'taxpayer name', 'name', 'client', 'taxpayer'],
  taxYear: ['tax year', 'year', 'ty'],
  returnType: ['return type', 'form', 'return', 'type'],
  agency: ['agency', 'jurisdiction', 'taxing authority', 'authority', 'state', 'fed/state', 'fed state'],
  status: ['status', 'ack status', 'acknowledgment status', 'acknowledgement status', 'efile status', 'e-file status', 'result'],
  submissionId: ['submission id', 'submission', 'sub id', 'dcn', 'declaration control number', 'irs submission id'],
  acknowledgedOn: ['ack date', 'acknowledgment date', 'acknowledgement date', 'date acknowledged', 'date', 'ack received'],
  rejectCode: ['reject code', 'error code', 'rejection code', 'code'],
  rejectReason: ['reject reason', 'error description', 'rejection reason', 'description', 'reason', 'message'],
  taxpayerId: ['ssn', 'ein', 'tin', 'taxpayer id', 'ssn/ein', 'id number', 'ssn last 4', 'last 4'],
};
const REQUIRED = ['clientName', 'agency', 'status'] as const;

function norm(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9/ ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export function resolveColumns(headers: string[]): { map: Record<string, string>; missing: string[] } {
  const normed = headers.map((h) => [norm(h), h] as const);
  const map: Record<string, string> = {};
  for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
    for (const alias of aliases) {
      const hit = normed.find(([n]) => n === alias);
      if (hit) { map[field] = hit[1]; break; }
    }
  }
  const missing = REQUIRED.filter((f) => !map[f]);
  return { map, missing };
}

function parseJurisdiction(raw: string): { jurisdiction: Jurisdiction; stateCode: string | null } | null {
  const v = raw.trim();
  if (!v) return null;
  if (/^(fed(eral)?|irs|us|federal return)$/i.test(v)) return { jurisdiction: 'federal', stateCode: null };
  const m = /^([A-Z]{2})\b/i.exec(v);
  if (m) return { jurisdiction: 'state', stateCode: m[1]!.toUpperCase() };
  return null;
}

function parseStatus(raw: string): AckStatus {
  const v = raw.trim().toLowerCase();
  if (/^(accepted|acc|ack accepted|irs accepted|state accepted)$/.test(v) || /\baccept/.test(v)) return 'accepted';
  if (/\breject/.test(v)) return 'rejected';
  return 'other';
}

function parseDate(raw: string | undefined): string | null {
  if (!raw) return null;
  const v = raw.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(v);
  if (m) return `${m[3]}-${m[1]!.padStart(2, '0')}-${m[2]!.padStart(2, '0')}`;
  return null;
}

function normReturnType(raw: string | undefined): string | null {
  if (!raw) return null;
  const v = raw.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!v) return null;
  if (v === '1120s') return '1120s';
  if (v === '990ez') return '990ez';
  return v;
}

/** Parse the report text. Throws a 422 naming the headers when the layout is not recognisable. */
export function parseAtxReport(text: string): { headers: string[]; rows: ParsedAckRow[]; skipped: Array<{ rowIndex: number; why: string }> } {
  const objects = parseCsvObjects(text);
  const headers = objects.length ? Object.keys(objects[0]!) : (text.split(/\r?\n/)[0] ?? '').split(',').map((h) => h.trim());
  const { map, missing } = resolveColumns(headers);
  if (missing.length) {
    throw new AppError(
      422,
      'ack_report_unrecognised',
      `This does not look like an ATX acknowledgment report: no column for ${missing.join(', ')}. Columns found: ${headers.join(' | ') || '(none)'}.`
    );
  }
  const get = (o: Record<string, string>, f: string): string | undefined => (map[f] ? o[map[f]!] : undefined);
  const rows: ParsedAckRow[] = [];
  const skipped: Array<{ rowIndex: number; why: string }> = [];
  objects.forEach((o, i) => {
    const rowIndex = i + 1;
    const clientName = (get(o, 'clientName') ?? '').trim();
    const j = parseJurisdiction(get(o, 'agency') ?? '');
    const statusRaw = (get(o, 'status') ?? '').trim();
    if (!clientName && !statusRaw) return; // a blank line
    if (!j) { skipped.push({ rowIndex, why: `agency "${get(o, 'agency') ?? ''}" is neither Federal nor a two-letter state` }); return; }
    const yearRaw = (get(o, 'taxYear') ?? '').trim();
    const taxYear = /^\d{4}$/.test(yearRaw) ? Number(yearRaw) : null;
    const tid = (get(o, 'taxpayerId') ?? '').replace(/\D/g, '');
    rows.push({
      rowIndex,
      clientName,
      taxYear,
      returnType: normReturnType(get(o, 'returnType')),
      jurisdiction: j.jurisdiction,
      stateCode: j.stateCode,
      status: parseStatus(statusRaw),
      statusRaw,
      submissionId: (get(o, 'submissionId') ?? '').trim() || null,
      acknowledgedOn: parseDate(get(o, 'acknowledgedOn')),
      rejectCode: (get(o, 'rejectCode') ?? '').trim() || null,
      rejectReason: (get(o, 'rejectReason') ?? '').trim() || null,
      taxpayerLast4: tid.length >= 4 ? tid.slice(-4) : null,
    });
  });
  return { headers, rows, skipped };
}

interface Candidate { id: string; contact_id: string; stage: string; first_name: string; last_name: string; language: 'en' | 'es'; email: string | null; ssn_last4: string | null }

/**
 * Exactly one return, or nothing. Name matching is on the FULL name, both orders, case and
 * accent insensitive; the last four of the taxpayer id, when the report has them, must agree
 * with what SAOS holds when SAOS holds anything. Two candidates is not a match.
 */
export async function matchRow(app: FastifyInstance, row: ParsedAckRow): Promise<{ te: Candidate | null; why: string }> {
  if (!row.taxYear) return { te: null, why: 'the row has no tax year' };
  if (!row.returnType) return { te: null, why: 'the row has no return type' };
  const { rows } = await app.db.query<Candidate>(
    `SELECT te.id, e.contact_id, te.stage::text AS stage, c.first_name, c.last_name, c.language, c.email, c.ssn_last4
       FROM tax_engagements te
       JOIN engagements e ON e.id = te.engagement_id
       JOIN contacts c ON c.id = e.contact_id
      WHERE te.tax_year = $1 AND te.return_type::text = $2
        AND te.stage NOT IN ('withdrawn')`,
    [row.taxYear, row.returnType]
  );
  const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const want = fold(row.clientName);
  const byName = rows.filter((c) => {
    const a = fold(`${c.first_name} ${c.last_name}`);
    const b = fold(`${c.last_name} ${c.first_name}`);
    const bc = fold(`${c.last_name}, ${c.first_name}`);
    return want === a || want === b || want === bc;
  });
  if (byName.length === 0) return { te: null, why: `no ${row.taxYear} ${row.returnType.toUpperCase()} return in SAOS for "${row.clientName}"` };
  const byId = row.taxpayerLast4
    ? byName.filter((c) => !c.ssn_last4 || c.ssn_last4 === row.taxpayerLast4)
    : byName;
  if (byId.length === 0) return { te: null, why: `"${row.clientName}" matched by name, but the taxpayer id on the report does not agree with the record` };
  if (byId.length > 1) return { te: null, why: `${byId.length} returns in SAOS could be "${row.clientName}" ${row.taxYear} ${row.returnType.toUpperCase()}; a person has to choose` };
  return { te: byId[0]!, why: 'matched' };
}

export interface IngestResult {
  reportId: string;
  rows: number;
  queued: number;
  tasks: number;
  duplicates: number;
  skipped: Array<{ rowIndex: number; why: string }>;
  alreadyIngested: boolean;
}

export async function ingestReport(
  app: FastifyInstance,
  actor: { id: string; label: string },
  input: { filename: string; text: string; today?: string | undefined }
): Promise<IngestResult> {
  const sha256 = createHash('sha256').update(input.text).digest('hex');
  const existing = await app.db.query<{ id: string; row_count: number; matched_count: number; task_count: number }>(
    `SELECT id, row_count, matched_count, task_count FROM efile_ack_reports WHERE sha256 = $1`, [sha256]);
  if (existing.rows[0]) {
    const r = existing.rows[0];
    return { reportId: r.id, rows: r.row_count, queued: r.matched_count, tasks: r.task_count, duplicates: 0, skipped: [], alreadyIngested: true };
  }

  const parsed = parseAtxReport(input.text);
  const { rows: rep } = await app.db.query<{ id: string }>(
    `INSERT INTO efile_ack_reports (filename, sha256, raw_text, uploaded_by, row_count) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [input.filename, sha256, input.text, actor.id, parsed.rows.length]
  );
  const reportId = rep[0]!.id;
  const preparerOwner = await ownerForRole(app.db, 'tax_preparer');

  let queued = 0, tasks = 0, duplicates = 0;
  for (const row of parsed.rows) {
    const { te, why } = await matchRow(app, row);
    let disposition: 'queued' | 'task' | 'duplicate' = 'task';
    let note = why;
    let taskId: string | null = null;

    if (te && row.status === 'accepted') {
      const dup = await app.db.query(
        `SELECT 1 FROM efile_acknowledgments
          WHERE tax_engagement_id = $1 AND jurisdiction = $2 AND COALESCE(state_code, '') = COALESCE($3, '')
            AND status = 'accepted' AND disposition IN ('queued', 'held', 'sent', 'suppressed') LIMIT 1`,
        [te.id, row.jurisdiction, row.stateCode]
      );
      if (dup.rows.length) {
        disposition = 'duplicate';
        note = `${row.jurisdiction === 'federal' ? 'Federal' : row.stateCode} acceptance already recorded for this return`;
        duplicates++;
      } else {
        disposition = 'queued';
        note = 'matched; accepted; will send when the report is released';
        queued++;
        // The return records the acknowledgment now — that is a fact regardless of the send.
        if (row.jurisdiction === 'federal') {
          await app.db.query(`UPDATE tax_engagements SET federal_accepted_on = COALESCE($2::date, CURRENT_DATE) WHERE id = $1`, [te.id, row.acknowledgedOn]);
          if (te.stage === 'filed') {
            await recordEfileResult(app, { staffId: actor.id, label: actor.label }, te.id, { result: 'accepted', today: input.today });
          }
        } else {
          await app.db.query(
            `UPDATE tax_engagements SET state_accepted_on = COALESCE($2::date, CURRENT_DATE), state_accepted_code = $3 WHERE id = $1`,
            [te.id, row.acknowledgedOn, row.stateCode]
          );
        }
      }
    } else if (te && row.status === 'rejected') {
      // A rejection is never a client email. The existing owned path: task + perfection clock.
      if (te.stage === 'filed') {
        await recordEfileResult(app, { staffId: actor.id, label: actor.label }, te.id, {
          result: 'rejected', rejectCode: row.rejectCode ?? undefined, rejectReason: row.rejectReason ?? undefined, today: input.today,
        });
        const t = await app.db.query<{ id: string }>(`SELECT id FROM tasks WHERE source_type = 'efile_reject' AND source_id = $1 ORDER BY created_at DESC LIMIT 1`, [te.id]);
        taskId = t.rows[0]?.id ?? null;
        note = `rejected by ${row.jurisdiction === 'federal' ? 'the IRS' : row.stateCode}: ${row.rejectCode ?? 'no code'} — re-file task raised`;
      } else {
        const t = await createTask(app, {
          title: `E-file rejected on a return that is not marked filed: ${te.last_name}, ${te.first_name} ${row.taxYear} ${(row.returnType ?? '').toUpperCase()}`,
          description: `The ATX report says ${row.jurisdiction === 'federal' ? 'the IRS' : row.stateCode} REJECTED this return (${row.rejectCode ?? 'no code'}: ${row.rejectReason ?? 'no reason given'}), but SAOS has it at '${te.stage}', not 'filed'. Bring the record in line, then handle the rejection. Report row ${row.rowIndex}.`,
          ...(preparerOwner ? { assignedStaffId: preparerOwner } : {}),
          contactId: te.contact_id, priority: 1, source: 'automation', sourceType: 'efile_ack_review', sourceId: `${reportId}:${row.rowIndex}`,
        });
        taskId = t.id;
        note = `rejected, but the return is '${te.stage}' in SAOS — task raised`;
      }
      tasks++;
    } else {
      // Unmatched, ambiguous, or a status that is neither accepted nor rejected. Never guessed.
      const t = await createTask(app, {
        title: `E-file acknowledgment could not be applied: "${row.clientName}" ${row.taxYear ?? '?'} ${(row.returnType ?? '?').toUpperCase()} (${row.jurisdiction === 'federal' ? 'Federal' : row.stateCode})`,
        description: `ATX report row ${row.rowIndex}: status "${row.statusRaw}"${row.submissionId ? `, submission ${row.submissionId}` : ''}. SAOS did not apply it because: ${te ? `status "${row.statusRaw}" is neither accepted nor rejected` : why}. Nothing was sent to anyone. Find the return, apply the acknowledgment by hand, and close this.`,
        ...(preparerOwner ? { assignedStaffId: preparerOwner } : {}),
        ...(te ? { contactId: te.contact_id } : {}),
        priority: 1, source: 'automation', sourceType: 'efile_ack_review', sourceId: `${reportId}:${row.rowIndex}`,
      });
      taskId = t.id;
      note = te ? `status "${row.statusRaw}" is neither accepted nor rejected — task raised` : `${why} — task raised`;
      tasks++;
    }

    await app.db.query(
      `INSERT INTO efile_acknowledgments
         (report_id, row_index, tax_engagement_id, jurisdiction, state_code, status, status_raw, submission_id, acknowledged_on,
          reject_code, reject_reason, client_name_raw, tax_year, return_type_raw, disposition, disposition_note, task_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [reportId, row.rowIndex, te?.id ?? null, row.jurisdiction, row.stateCode, row.status, row.statusRaw, row.submissionId, row.acknowledgedOn,
       row.rejectCode, row.rejectReason, row.clientName, row.taxYear, row.returnType, disposition, note, taskId]
    );
  }
  await app.db.query(`UPDATE efile_ack_reports SET matched_count = $2, task_count = $3 WHERE id = $1`, [reportId, queued, tasks]);
  await writeAudit(app.db, {
    actorType: 'staff', actorId: actor.id, actorLabel: actor.label,
    action: 'efile_ack.report_ingested', objectType: 'efile_ack_report', objectId: reportId,
    details: { filename: input.filename, sha256, rows: parsed.rows.length, queued, tasks, duplicates, skipped: parsed.skipped.length },
  });
  return { reportId, rows: parsed.rows.length, queued, tasks, duplicates, skipped: parsed.skipped, alreadyIngested: false };
}

export async function holdRow(app: FastifyInstance, actor: { id: string; label: string }, ackId: string, hold: boolean): Promise<void> {
  const { rows } = await app.db.query<{ disposition: string; report_id: string }>(`SELECT disposition::text AS disposition, report_id FROM efile_acknowledgments WHERE id = $1`, [ackId]);
  const r = rows[0];
  if (!r) throw new AppError(404, 'not_found', 'No such acknowledgment row.');
  if (hold && r.disposition !== 'queued') throw new AppError(409, 'not_queued', `Only a queued row can be held; this one is '${r.disposition}'.`);
  if (!hold && r.disposition !== 'held') throw new AppError(409, 'not_held', `This row is '${r.disposition}', not held.`);
  await app.db.query(
    `UPDATE efile_acknowledgments SET disposition = $2::efile_ack_disposition, held_by = $3, held_at = CASE WHEN $2::text = 'held' THEN now() ELSE NULL END WHERE id = $1`,
    [ackId, hold ? 'held' : 'queued', hold ? actor.id : null]
  );
  await writeAudit(app.db, { actorType: 'staff', actorId: actor.id, actorLabel: actor.label, action: hold ? 'efile_ack.row_held' : 'efile_ack.row_released', objectType: 'efile_ack', objectId: ackId, details: { report_id: r.report_id } });
}

/*
 * RELEASE IS A REQUIRED STEP, not optional. Three reasons, and the third decides it:
 *   1. The automation replaces a person who read every acceptance before writing to a client;
 *      the parse is good but a report is a file someone exported, and a mis-parsed row costs a
 *      client a wrong "your return was accepted". One click on a screen that already lists the
 *      rows is cheap against that.
 *   2. Brian arms the automation once; Ana-Maria owns each batch. The gate says "this kind of
 *      send may go"; the release says "these sends may go". They are different decisions.
 *   3. The audit line "actor is Ana-Maria" has to be literally true of the send decision, not
 *      only of the upload. An optional step would make it true sometimes.
 */
export async function releaseReport(app: FastifyInstance, actor: { id: string; label: string }, reportId: string): Promise<{ enqueued: number; held: number }> {
  const rep = await app.db.query<{ id: string; released_at: Date | null }>(`SELECT id, released_at FROM efile_ack_reports WHERE id = $1`, [reportId]);
  if (!rep.rows[0]) throw new AppError(404, 'not_found', 'No such report.');
  const { rows } = await app.db.query<{ id: string; tax_engagement_id: string; contact_id: string }>(
    `SELECT a.id, a.tax_engagement_id, e.contact_id
       FROM efile_acknowledgments a
       JOIN tax_engagements te ON te.id = a.tax_engagement_id
       JOIN engagements e ON e.id = te.engagement_id
      WHERE a.report_id = $1 AND a.disposition = 'queued'`,
    [reportId]
  );
  for (const r of rows) {
    await enqueueEffect(app, { effect: 'efile.ack_notice', payload: { ackId: r.id }, contactId: r.contact_id, objectType: 'efile_ack', objectId: r.id });
  }
  const held = await app.db.query<{ n: string }>(`SELECT count(*) AS n FROM efile_acknowledgments WHERE report_id = $1 AND disposition = 'held'`, [reportId]);
  await app.db.query(`UPDATE efile_ack_reports SET released_by = $2, released_at = now() WHERE id = $1`, [reportId, actor.id]);
  await writeAudit(app.db, { actorType: 'staff', actorId: actor.id, actorLabel: actor.label, action: 'efile_ack.report_released', objectType: 'efile_ack_report', objectId: reportId, details: { enqueued: rows.length, held: Number(held.rows[0]!.n) } });
  return { enqueued: rows.length, held: Number(held.rows[0]!.n) };
}

/** The outbox handler for `efile.ack_notice`. Gated. Federal and state are different messages. */
export async function sendEfileAckNotice(app: FastifyInstance, ackId: string): Promise<{ sent: boolean; reason?: string }> {
  const { rows } = await app.db.query<{
    id: string; disposition: string; jurisdiction: Jurisdiction; state_code: string | null; acknowledged_on: string | null;
    tax_year: number; return_type: string; contact_id: string; first_name: string; email: string | null; language: 'en' | 'es';
  }>(
    `SELECT a.id, a.disposition::text AS disposition, a.jurisdiction::text AS jurisdiction, a.state_code, a.acknowledged_on::text AS acknowledged_on,
            te.tax_year, te.return_type::text AS return_type, e.contact_id, c.first_name, c.email, c.language
       FROM efile_acknowledgments a
       JOIN tax_engagements te ON te.id = a.tax_engagement_id
       JOIN engagements e ON e.id = te.engagement_id
       JOIN contacts c ON c.id = e.contact_id
      WHERE a.id = $1`,
    [ackId]
  );
  const a = rows[0];
  if (!a) return { sent: false, reason: 'ack not found' };
  if (a.disposition === 'sent') return { sent: false, reason: 'already_sent' };
  if (a.disposition !== 'queued') return { sent: false, reason: 'already_sent' }; // held or otherwise withdrawn after release: retire quietly
  if (!a.email) return { sent: false, reason: 'no_email' };

  if (!(await isAutomationEnabled(app, 'efile_acknowledgment'))) {
    await app.db.query(`UPDATE efile_acknowledgments SET disposition = 'suppressed' WHERE id = $1`, [ackId]);
    await writeAudit(app.db, {
      actorType: 'system', actorLabel: 'outbox', action: 'efile_ack.notice_suppressed', objectType: 'efile_ack', objectId: ackId, contactId: a.contact_id,
      details: { automation: 'efile_acknowledgment', jurisdiction: a.jurisdiction, state_code: a.state_code, tax_year: a.tax_year },
    });
    return { sent: false, reason: 'suppressed' };
  }

  const templateKey = a.jurisdiction === 'federal' ? 'efile_accepted_federal' : 'efile_accepted_state';
  await sendTemplatedEmail(app, {
    to: a.email, templateKey, language: a.language, contactId: a.contact_id,
    vars: {
      first_name: a.first_name,
      tax_year: String(a.tax_year),
      return_type: a.return_type.toUpperCase(),
      state_code: a.state_code ?? '',
      acknowledged_on: a.acknowledged_on ?? '',
    },
  });
  await app.db.query(`UPDATE efile_acknowledgments SET disposition = 'sent', sent_at = now() WHERE id = $1`, [ackId]);
  await writeAudit(app.db, {
    actorType: 'system', actorLabel: 'outbox', action: 'efile_ack.notice_sent', objectType: 'efile_ack', objectId: ackId, contactId: a.contact_id,
    details: { template: templateKey, jurisdiction: a.jurisdiction, state_code: a.state_code, tax_year: a.tax_year, language: a.language },
  });
  return { sent: true };
}

export async function reportView(app: FastifyInstance, reportId: string) {
  const rep = await app.db.query(
    `SELECT r.id, r.filename, r.uploaded_at, r.released_at, r.row_count, r.matched_count, r.task_count,
            u.full_name AS uploaded_by, rl.full_name AS released_by
       FROM efile_ack_reports r JOIN staff u ON u.id = r.uploaded_by LEFT JOIN staff rl ON rl.id = r.released_by
      WHERE r.id = $1`, [reportId]);
  if (!rep.rows[0]) throw new AppError(404, 'not_found', 'No such report.');
  const rows = await app.db.query(
    `SELECT a.id, a.row_index, a.jurisdiction::text AS jurisdiction, a.state_code, a.status::text AS status, a.status_raw,
            a.submission_id, a.acknowledged_on::text AS acknowledged_on, a.reject_code, a.client_name_raw, a.tax_year, a.return_type_raw,
            a.disposition::text AS disposition, a.disposition_note, a.task_id, a.sent_at,
            te.id AS tax_engagement_id, c.id AS contact_id, c.first_name || ' ' || c.last_name AS client, c.language
       FROM efile_acknowledgments a
       LEFT JOIN tax_engagements te ON te.id = a.tax_engagement_id
       LEFT JOIN engagements e ON e.id = te.engagement_id
       LEFT JOIN contacts c ON c.id = e.contact_id
      WHERE a.report_id = $1 ORDER BY a.row_index`, [reportId]);
  return { report: rep.rows[0], rows: rows.rows };
}

export async function listReports(app: FastifyInstance) {
  const { rows } = await app.db.query(
    `SELECT r.id, r.filename, r.uploaded_at, r.released_at, r.row_count, r.matched_count, r.task_count, u.full_name AS uploaded_by
       FROM efile_ack_reports r JOIN staff u ON u.id = r.uploaded_by ORDER BY r.uploaded_at DESC LIMIT 50`);
  return rows;
}
