/*
 * E-FILE ACKNOWLEDGMENT AUTOMATION (2026-09-12, Brian's ruling), REBUILT AGAINST THE REAL ATX
 * EXPORT (R43, 2026-09-26).
 *
 * Laura, offshore, used to read the ATX e-file report by hand and email each client that the IRS
 * or the state had accepted their return. This is what replaces her, and its shape is deliberate:
 *
 *   UPLOAD   The preparer uploads ATX's "E-Files" export — the committed fixture at
 *            test/fixtures/atx/ATX_EFiles_synthetic.csv is its exact shape (read the README there).
 *            Columns are read by NAME; a file missing a required column is refused whole with the
 *            headers it did have, never guessed at. The file is stored with EVERY IDENTIFIER MASKED
 *            to its last four; the parser never writes a full SSN or EIN anywhere.
 *   MATCH    There is no tax-year column and none is needed. A row is matched ONLY against SAOS
 *            returns at 'filed' that are still awaiting that jurisdiction, on the identifier's last
 *            four, the form family and the jurisdiction; the folded name and any year suffix on the
 *            name ("LAST, FIRST 2025") are tiebreaks, never filters. The tax year comes from the
 *            matched SAOS return. The export is firm-wide, so MOST ROWS MATCH NOTHING: they are
 *            listed and counted as unmatched, and produce no task and no send.
 *   STATUS   Accepted and AcceptedWithMessages are both accepted (the second is flagged). Created,
 *            Held and TransmittedToAgency are pending: listed, no action. RejectedByAgency,
 *            RejectedByEfc and RejectedByUser are rejections. A rejection raises a task ONLY when
 *            the row matched an SAOS return; it takes the existing owned re-file path.
 *   EXTEND   An extension row (Sub Type Extension; Type 4868, 7004 or 8868) that matches a NOT-YET-
 *            FILED SAOS return proposes an R12 extension record for review — the Record extension
 *            door with the form and the date filed. It sends nothing. The preparer records it from
 *            the review screen, or leaves it.
 *   REVIEW   Nothing sends on upload. The review screen lists the matched rows and the unmatched
 *            count with the unmatched rows under it (masked identifiers). Hold any row. Release is a
 *            separate, explicit step and releases only matched accepted rows.
 *   SEND     Released rows become outbox effects. The handler is gated by the efile_acknowledgment
 *            automation (ships OFF; Brian arms it), EN/ES by the client's language, federal and state
 *            as two different messages.
 *
 * PERSISTENCE RULE (R43). SAOS keeps the identifier's LAST FOUR only — never the full SSN/EIN, never
 * in the raw file store, never in task text or audit rows. Task text names the return by form and
 * year and the client by the SAOS contact, never by the export's name field. The withdraw door voids
 * a report so its file can be uploaded again; the purge door rewrites the identifiers a report made
 * before this rule to their last four, audited.
 *
 * THE STATUS DATE IS CENTRAL TIME: "M/D/YYYY h:mm:ss AM/PM" as ATX prints it, America/Chicago.
 */
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { AppError } from '../../types.ts';
import { writeAudit } from '../../audit.ts';
import { parseCsvObjects } from '../../migration/csv.ts';
import { createTask } from '../tasks/service.ts';
import { alertRecipientForRole } from '../../staffing.ts';
import { isAutomationEnabled } from '../../automations.ts';
import { enqueueEffect } from '../../outbox.ts';
import { sendTemplatedEmail } from '../templates/service.ts';
import { acceptanceStatus, recordEfileResult, stampJurisdictionAccepted, TAX_STAGES } from './pipeline.ts';
import { markExtensionFiled, type ExtensionForm } from './extension.ts';
import { todayChicago } from './deadlines.ts';

export type Jurisdiction = 'federal' | 'state';
export type AckStatus = 'accepted' | 'rejected' | 'pending' | 'other';
export type RowKind = 'return' | 'extension' | 'amended';

export interface ParsedAckRow {
  rowIndex: number;
  /** The export's "Return Name", as printed. Shown on the review screen; never written into a task. */
  nameRaw: string;
  /** The name without its year suffix, folded for comparison. */
  nameFolded: string;
  /** "LAST, FIRST 2025" carries a year; a business name usually does not. A tiebreak, never a filter. */
  yearSuffix: number | null;
  /** The LAST FOUR of the SSN/EIN. The full value is read and dropped in the same expression. */
  taxpayerLast4: string | null;
  jurisdiction: Jurisdiction;
  stateCode: string | null;
  formRaw: string;
  /** The SAOS return-type family the form implies ('1040', '1120s', ...), or null when the form is not one SAOS knows. */
  formFamily: string | null;
  kind: RowKind;
  subTypeRaw: string;
  /** For an extension row: which form, from the Type column or implied by the family. */
  extensionForm: ExtensionForm | null;
  status: AckStatus;
  statusRaw: string;
  acceptedWithMessages: boolean;
  /** The Status Date as printed, Central: YYYY-MM-DD. */
  acknowledgedOn: string | null;
  /** The same instant in UTC, ISO. */
  statusAt: string | null;
  /** ATX's E-file ID for the submission. */
  submissionId: string | null;
}

/*
 * THE REAL HEADER (fixture README): Return Name, Client #, Complete, SSN/EIN, E-file ID, Jurisdiction,
 * Type, Sub Type, Status, Status Date, PIN Status, Refund Amount, Refund Type, Signature, EIC Indicator,
 * Processing Site. Headers are matched case-insensitively after folding punctuation; the aliases admit
 * the one or two spellings ATX has used, nothing broader — the 2026-09-20 parser matched "Client #" as
 * the client name through an alias list built for a report that did not exist.
 */
const COLUMN_ALIASES: Record<string, string[]> = {
  name: ['return name'],
  taxpayerId: ['ssn/ein', 'ssn ein', 'ein/ssn'],
  submissionId: ['e file id', 'efile id', 'e-file id'],
  jurisdiction: ['jurisdiction'],
  type: ['type', 'form'],
  subType: ['sub type', 'subtype'],
  status: ['status'],
  statusDate: ['status date'],
};
const REQUIRED = ['name', 'taxpayerId', 'jurisdiction', 'type', 'subType', 'status', 'statusDate'] as const;

function norm(h: string): string {
  return h.replace(/^﻿/, '').toLowerCase().replace(/[^a-z0-9/ -]+/g, ' ').replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
}

export function resolveColumns(headers: string[]): { map: Record<string, string>; missing: string[] } {
  const normed = headers.map((h) => [norm(h), h] as const);
  const map: Record<string, string> = {};
  for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
    for (const alias of aliases) {
      const hit = normed.find(([n]) => n === norm(alias));
      if (hit) { map[field] = hit[1]; break; }
    }
  }
  // Missing columns are named the way the export prints them, so the person can see what ATX produced.
  const missing = REQUIRED.filter((f) => !map[f]).map((f) => COLUMN_ALIASES[f]![0]!);
  return { map, missing };
}

/** A standalone run of nine digits, with ATX's optional leading apostrophe: an SSN or an EIN. */
const IDENTIFIER = /'?\b\d{9}\b/g;
/**
 * The same shape in PostgreSQL's regex dialect, for counting and purging in SQL. Word-bounded like the
 * JS pattern: nine digits glued to letters are a hash or an E-file ID, not an identifier.
 */
export const IDENTIFIER_SQL = '(?<![0-9A-Za-z])[0-9]{9}(?![0-9A-Za-z])';

/** Every nine-digit identifier in a text rewritten to its last four. What the raw file is stored as. */
export function maskIdentifiers(text: string): string {
  return text.replace(IDENTIFIER, (m) => `*****${m.slice(-4)}`);
}

/** The last four of the SSN/EIN on a row; nothing else survives the expression. */
function last4Of(raw: string | undefined): string | null {
  const digits = (raw ?? '').replace(/\D/g, '');
  return digits.length >= 4 ? digits.slice(-4) : null;
}

/** Accent- and case-insensitive, punctuation folded to spaces. */
export function foldName(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Legal suffixes and punctuation do not make two names two entities: "Soto Accounting, LLC" is "Soto Accounting LLC". */
export function foldEntityName(s: string): string {
  return foldName(s)
    .replace(/\b(llc|l l c|inc|incorporated|corp|corporation|co|company|ltd|limited|pllc|pc|lp|llp|the|nfp)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** "SYNTHETIC, PERSON A 2025" → the name and 2025; "SYNTHETIC SCORP LLC" → the name and null. */
export function splitYearSuffix(nameRaw: string): { name: string; year: number | null } {
  const m = /^(.*?)\s+((?:19|20)\d{2})\s*$/.exec(nameRaw.trim());
  if (m) return { name: m[1]!.trim(), year: Number(m[2]) };
  return { name: nameRaw.trim(), year: null };
}

function parseJurisdiction(raw: string): { jurisdiction: Jurisdiction; stateCode: string | null } | null {
  const v = raw.trim();
  if (!v) return null;
  if (/^(fed(eral)?|irs|us)$/i.test(v)) return { jurisdiction: 'federal', stateCode: null };
  if (/^[A-Z]{2}$/i.test(v)) return { jurisdiction: 'state', stateCode: v.toUpperCase() };
  return null;
}

/** The SAOS return types each form family covers. */
const RETURN_TYPE_FAMILY: Record<string, string> = {
  '1040': '1040', '1040_expat': '1040', '1041': '1041', '1065': '1065', '1120s': '1120s', '1120': '1120',
  '1120c': '1120c', '1120f': '1120f', '1120f_foreign': '1120f', '1120h': '1120h', '1120pol': '1120pol',
  '990': '990', '990ez': '990ez', '990pf': '990pf', '990t': '990t',
};
export function returnTypesForFamily(family: string): string[] {
  return Object.entries(RETURN_TYPE_FAMILY).filter(([, f]) => f === family).map(([t]) => t);
}
/** Which return families each extension form extends. */
const EXTENSION_FAMILIES: Record<ExtensionForm, string[]> = {
  '4868': ['1040'],
  '7004': ['1065', '1120s', '1120', '1120c', '1120f', '1120h', '1120pol', '1041'],
  '8868': ['990', '990ez', '990pf', '990t'],
};

/*
 * THE FORM FAMILY. Federal rows print the form ("1120S", "1040", "990EZ"); state rows print the
 * state's own form behind its code ("IL 1120-ST", "CA 540NR", "WI 1"). The family is the SAOS return
 * type the form belongs to. A state form this table does not know leaves the family null: the row
 * is then matched on the identifier and the jurisdiction alone, which is still exact when one return
 * awaits that state for that identifier — and unmatched otherwise.
 */
const FAMILY_RULES: Array<[RegExp, string]> = [
  [/^1120S/, '1120s'], [/^1120H/, '1120h'], [/^1120F/, '1120f'], [/^1120POL/, '1120pol'], [/^1120C/, '1120c'], [/^1120/, '1120'],
  [/^1065/, '1065'], [/^990EZ/, '990ez'], [/^990PF/, '990pf'], [/^990T/, '990t'], [/^990/, '990'], [/^1041/, '1041'], [/^1040/, '1040'],
  // State entity forms seen on exports: California 100S/100/565/568, New York CT-3-S/CT-3/IT-204.
  [/^100S/, '1120s'], [/^100$/, '1120'], [/^(565|568)/, '1065'], [/^CT3S/, '1120s'], [/^CT3$/, '1120'], [/^IT204/, '1065'],
  // State individual forms: California, New York, Indiana, North Carolina, Wisconsin, Minnesota, Pennsylvania,
  // Michigan, New Jersey, Oregon/Alabama, Colorado, Oklahoma, DC, Ohio, South Carolina, Nebraska, Kansas,
  // Missouri, Kentucky, West Virginia, Mississippi, Montana, Arkansas, Georgia, Iowa, Maine.
  [/^(540|540NR|540EZ|5402EZ|IT201|IT203|IT40|IT40PNR|D400|1$|1NPR|M1$|PA40|MI1040|NJ1040|NJ1040NR|40$|40N|104$|511|D40|IT1040|SC1040|1040N|K40|MO1040|740|IT140|80105|2$|AR1000F|500$|500EZ|IA1040|1040ME)/, '1040'],
];

export function formFamily(typeRaw: string, stateCode: string | null): { family: string | null; extensionForm: ExtensionForm | null } {
  let v = typeRaw.trim().toUpperCase();
  if (stateCode && v.startsWith(`${stateCode} `)) v = v.slice(3);
  else if (/^[A-Z]{2}\s/.test(v)) v = v.slice(3);
  const c = v.replace(/[^A-Z0-9]/g, '');
  if (c === '4868') return { family: '1040', extensionForm: '4868' };
  if (c === '7004') return { family: null, extensionForm: '7004' };
  if (c === '8868') return { family: '990', extensionForm: '8868' };
  for (const [re, family] of FAMILY_RULES) if (re.test(c)) return { family, extensionForm: null };
  return { family: null, extensionForm: null };
}

export function parseStatus(raw: string): { status: AckStatus; acceptedWithMessages: boolean } {
  const v = raw.replace(/[\s_-]+/g, '').toLowerCase();
  if (v === 'accepted') return { status: 'accepted', acceptedWithMessages: false };
  if (v === 'acceptedwithmessages') return { status: 'accepted', acceptedWithMessages: true };
  if (v === 'created' || v === 'held' || v === 'transmittedtoagency') return { status: 'pending', acceptedWithMessages: false };
  if (v.startsWith('rejected')) return { status: 'rejected', acceptedWithMessages: false };
  return { status: 'other', acceptedWithMessages: false };
}

/** Minutes America/Chicago is ahead of UTC at the given instant (negative: -300 CDT, -360 CST). */
function chicagoOffsetMinutes(utcMs: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const g = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const asUtc = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour') % 24, g('minute'), g('second'));
  return Math.round((asUtc - utcMs) / 60000);
}

/** A wall-clock time in Chicago as a UTC instant, DST included. */
export function chicagoToUtcIso(y: number, mo: number, d: number, h: number, mi: number, s: number): string {
  const local = Date.UTC(y, mo - 1, d, h, mi, s);
  let guess = local - chicagoOffsetMinutes(local) * 60000;
  guess = local - chicagoOffsetMinutes(guess) * 60000;
  return new Date(guess).toISOString();
}

/** "9/15/2026 6:41:08 PM" (Central) → the printed date and the UTC instant. A bare date is midnight Central. */
export function parseStatusDate(raw: string | undefined): { acknowledgedOn: string | null; statusAt: string | null } {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?$/i.exec((raw ?? '').trim());
  if (!m) return { acknowledgedOn: null, statusAt: null };
  const mo = Number(m[1]); const d = Number(m[2]); const y = Number(m[3]);
  let h = m[4] ? Number(m[4]) : 0;
  const mi = m[5] ? Number(m[5]) : 0;
  const s = m[6] ? Number(m[6]) : 0;
  const ap = m[7]?.toUpperCase();
  if (ap === 'PM' && h < 12) h += 12;
  if (ap === 'AM' && h === 12) h = 0;
  return {
    acknowledgedOn: `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
    statusAt: chicagoToUtcIso(y, mo, d, h, mi, s),
  };
}

/** Parse the export. Throws a 422 naming the headers when the layout is not the ATX E-Files export. */
export function parseAtxReport(text: string): { headers: string[]; rows: ParsedAckRow[]; skipped: Array<{ rowIndex: number; why: string }> } {
  const objects = parseCsvObjects(text);
  const headers = objects.length ? Object.keys(objects[0]!) : (text.replace(/^﻿/, '').split(/\r?\n/)[0] ?? '').split(',').map((h) => h.trim());
  const { map, missing } = resolveColumns(headers);
  if (missing.length) {
    throw new AppError(
      422,
      'ack_report_unrecognised',
      `This does not look like the ATX E-Files export: no column for ${missing.join(', ')}. Columns found: ${headers.join(' | ') || '(none)'}.`
    );
  }
  const get = (o: Record<string, string>, f: string): string | undefined => (map[f] ? o[map[f]!] : undefined);
  const rows: ParsedAckRow[] = [];
  const skipped: Array<{ rowIndex: number; why: string }> = [];
  objects.forEach((o, i) => {
    const rowIndex = i + 1;
    const nameRaw = (get(o, 'name') ?? '').trim();
    const statusRaw = (get(o, 'status') ?? '').trim();
    if (!nameRaw && !statusRaw) return; // a blank line
    const j = parseJurisdiction(get(o, 'jurisdiction') ?? '');
    if (!j) { skipped.push({ rowIndex, why: `jurisdiction "${get(o, 'jurisdiction') ?? ''}" is neither Federal nor a two-letter state` }); return; }
    const formRaw = (get(o, 'type') ?? '').trim();
    const subTypeRaw = (get(o, 'subType') ?? '').trim();
    const { family, extensionForm: formOnType } = formFamily(formRaw, j.stateCode);
    const sub = subTypeRaw.toLowerCase();
    const kind: RowKind = formOnType || sub === 'extension' ? 'extension' : sub === 'amended' ? 'amended' : 'return';
    const extensionForm: ExtensionForm | null =
      kind !== 'extension' ? null : formOnType ?? (family === '1040' ? '4868' : family === '990' || family === '990ez' ? '8868' : '7004');
    const { name, year } = splitYearSuffix(nameRaw);
    const st = parseStatus(statusRaw);
    const when = parseStatusDate(get(o, 'statusDate'));
    rows.push({
      rowIndex,
      nameRaw,
      nameFolded: foldName(name),
      yearSuffix: year,
      taxpayerLast4: last4Of(get(o, 'taxpayerId')),
      jurisdiction: j.jurisdiction,
      stateCode: j.stateCode,
      formRaw,
      formFamily: family,
      kind,
      subTypeRaw,
      extensionForm,
      status: st.status,
      statusRaw,
      acceptedWithMessages: st.acceptedWithMessages,
      acknowledgedOn: when.acknowledgedOn,
      statusAt: when.statusAt,
      submissionId: (get(o, 'submissionId') ?? '').trim() || null,
    });
  });
  return { headers, rows, skipped };
}

interface Candidate {
  id: string; contact_id: string; stage: string; tax_year: number; return_type: string; preparer_id: string | null;
  first_name: string; last_name: string; language: 'en' | 'es'; email: string | null;
  business_name: string | null;
  /** The EIN's last four on a business return, the contact's SSN last four otherwise. */
  held_last4: string | null;
  extension_filed: boolean;
}

const PRE_FILED_STAGES = TAX_STAGES.filter((s) => TAX_STAGES.indexOf(s) < TAX_STAGES.indexOf('filed') || s === 'on_hold');

async function candidates(app: FastifyInstance, stages: readonly string[], returnTypes: string[] | null, last4: string): Promise<Candidate[]> {
  const { rows } = await app.db.query<Candidate>(
    `SELECT te.id, e.contact_id, te.stage::text AS stage, te.tax_year, te.return_type::text AS return_type, te.preparer_id,
            c.first_name, c.last_name, c.language, c.email, b.name AS business_name, te.extension_filed,
            COALESCE(NULLIF(right(regexp_replace(COALESCE(b.ein, ''), '[^0-9]', '', 'g'), 4), ''), c.ssn_last4) AS held_last4
       FROM tax_engagements te
       JOIN engagements e ON e.id = te.engagement_id
       JOIN contacts c ON c.id = e.contact_id
       LEFT JOIN businesses b ON b.id = e.business_id
      WHERE te.stage::text = ANY($1::text[])
        AND ($2::text[] IS NULL OR te.return_type::text = ANY($2::text[]))
        AND COALESCE(NULLIF(right(regexp_replace(COALESCE(b.ein, ''), '[^0-9]', '', 'g'), 4), ''), c.ssn_last4) = $3`,
    [stages, returnTypes, last4]
  );
  return rows;
}

/** Does the export's name agree with the SAOS record? An entity by its folded entity name; a person in either order. */
function nameAgrees(row: ParsedAckRow, c: Candidate): boolean {
  if (c.business_name) return foldEntityName(c.business_name) === foldEntityName(row.nameFolded);
  const want = row.nameFolded;
  return want === foldName(`${c.last_name} ${c.first_name}`) || want === foldName(`${c.first_name} ${c.last_name}`);
}

/**
 * One return, or nothing. The identifier, the form family and the jurisdiction have already narrowed
 * the field; the name and the year suffix only separate what is left, and two returns they cannot
 * separate is an unmatched row, never a guess.
 */
export function tiebreak(row: ParsedAckRow, cands: Candidate[]): { te: Candidate | null; why: string; nameAgrees: boolean } {
  if (cands.length === 0) return { te: null, why: 'none', nameAgrees: false };
  if (cands.length === 1) return { te: cands[0]!, why: 'matched', nameAgrees: nameAgrees(row, cands[0]!) };
  let left = cands;
  const byName = left.filter((c) => nameAgrees(row, c));
  if (byName.length === 1) return { te: byName[0]!, why: 'matched (name)', nameAgrees: true };
  if (byName.length > 1) left = byName;
  if (row.yearSuffix) {
    const byYear = left.filter((c) => c.tax_year === row.yearSuffix);
    if (byYear.length === 1) return { te: byYear[0]!, why: 'matched (year)', nameAgrees: nameAgrees(row, byYear[0]!) };
    if (byYear.length > 1) left = byYear;
  }
  return { te: null, why: `${left.length} SAOS returns fit this row (same last four, form and jurisdiction) and the name and year do not separate them; a person has to apply it`, nameAgrees: false };
}

/**
 * The acceptance applied to the return: the jurisdiction's date and submission id stamped, then the
 * completion check through recordEfileResult (complete only when nothing is still awaited). Shared by
 * the ingest and by the unhold of a row that was held for review before anything was applied.
 */
async function applyAcceptance(
  app: FastifyInstance,
  actor: { id: string; label: string },
  taxEngagementId: string,
  row: { jurisdiction: Jurisdiction; stateCode: string | null; acknowledgedOn: string | null; submissionId: string | null },
  today: string
): Promise<{ stage: string; awaiting: string[] }> {
  const code = row.jurisdiction === 'federal' ? 'federal' : row.stateCode!;
  await stampJurisdictionAccepted(app, taxEngagementId, code, row.acknowledgedOn, row.submissionId);
  return recordEfileResult(app, { staffId: actor.id, label: actor.label }, taxEngagementId, {
    result: 'accepted', jurisdiction: row.jurisdiction, stateCode: row.stateCode ?? undefined, today,
  });
}

const jurisdictionLabel = (row: ParsedAckRow) => (row.jurisdiction === 'federal' ? 'Federal' : row.stateCode!);
const jurisdictionCode = (row: ParsedAckRow) => (row.jurisdiction === 'federal' ? 'federal' : row.stateCode!);
/** How a task names the return: by form and year, and the client by the SAOS record. Never the export's name. */
const returnLabel = (te: Candidate) => `${te.return_type.toUpperCase()} ${te.tax_year}`;
const clientLabel = (te: Candidate) => te.business_name ?? `${te.first_name} ${te.last_name}`;

export interface IngestResult {
  reportId: string;
  rows: number;
  queued: number;
  tasks: number;
  duplicates: number;
  unmatched: number;
  pending: number;
  extensions: number;
  skipped: Array<{ rowIndex: number; why: string }>;
  alreadyIngested: boolean;
}

type Disposition = 'queued' | 'held' | 'sent' | 'suppressed' | 'task' | 'duplicate' | 'unmatched' | 'pending' | 'extension_proposed' | 'extension_recorded';

export async function ingestReport(
  app: FastifyInstance,
  actor: { id: string; label: string },
  input: { filename: string; text: string; today?: string | undefined }
): Promise<IngestResult> {
  const sha256 = createHash('sha256').update(input.text).digest('hex');
  const existing = await app.db.query<{ id: string; row_count: number; matched_count: number; task_count: number; unmatched_count: number; pending_count: number; extension_count: number }>(
    `SELECT id, row_count, matched_count, task_count, unmatched_count, pending_count, extension_count
       FROM efile_ack_reports WHERE sha256 = $1 AND withdrawn_at IS NULL`, [sha256]);
  if (existing.rows[0]) {
    const r = existing.rows[0];
    return { reportId: r.id, rows: r.row_count, queued: r.matched_count, tasks: r.task_count, duplicates: 0, unmatched: r.unmatched_count, pending: r.pending_count, extensions: r.extension_count, skipped: [], alreadyIngested: true };
  }

  const parsed = parseAtxReport(input.text);
  // THE FILE IS STORED MASKED: every identifier to its last four before the INSERT.
  const { rows: rep } = await app.db.query<{ id: string }>(
    `INSERT INTO efile_ack_reports (filename, sha256, raw_text, uploaded_by, row_count) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [input.filename, sha256, maskIdentifiers(input.text), actor.id, parsed.rows.length]
  );
  const reportId = rep[0]!.id;
  const today = input.today ?? todayChicago();

  let queued = 0, tasks = 0, duplicates = 0, unmatched = 0, pending = 0, extensions = 0;
  for (const row of parsed.rows) {
    let te: Candidate | null = null;
    let disposition: Disposition = 'unmatched';
    let note = '';
    let taskId: string | null = null;
    const where = jurisdictionLabel(row);
    const withMessages = row.acceptedWithMessages ? ' (accepted with messages)' : '';

    if (!row.taxpayerLast4) {
      note = 'no identifier on the row to match on; listed only';
    } else if (row.kind === 'amended') {
      note = 'an amended return has no SAOS record to match; listed only';
    } else if (row.kind === 'extension') {
      /*
       * AN EXTENSION ROW PROPOSES AN R12 RECORD (R43): only a federal extension (a state extension has
       * no SAOS record), only against a return NOT YET FILED, only proposed — the preparer records it
       * from the review screen through the Record extension door. Nothing is emailed.
       */
      const form = row.extensionForm!;
      if (row.jurisdiction !== 'federal') {
        note = `a ${where} extension has no SAOS record; the federal extension row is what SAOS records. Listed only`;
      } else {
        const fam = row.formFamily ? [row.formFamily] : EXTENSION_FAMILIES[form];
        const cands = await candidates(app, PRE_FILED_STAGES, fam.flatMap(returnTypesForFamily), row.taxpayerLast4);
        const pick = tiebreak(row, cands);
        te = pick.te;
        if (!te) {
          note = pick.why === 'none' ? `no SAOS return before filing awaits a ${form} extension for this identifier; listed only` : pick.why;
        } else if (te.extension_filed) {
          disposition = 'duplicate';
          note = `an extension is already recorded on ${returnLabel(te)}`;
          duplicates++;
        } else if (row.status === 'accepted') {
          disposition = 'extension_proposed';
          note = `proposes a Form ${form} extension filed ${row.acknowledgedOn ?? 'on an unknown date'} on ${returnLabel(te)}${withMessages}; record it from this screen. No email.`;
          extensions++;
        } else if (row.status === 'rejected') {
          const owner = te.preparer_id ?? (await alertRecipientForRole(app.db, 'tax_preparer', 'efile_extension_rejected'));
          const t = await createTask(app, {
            title: `Extension ${form} REJECTED at ATX: ${returnLabel(te)} for ${clientLabel(te)}`,
            description: `ATX export row ${row.rowIndex} (${row.statusRaw}${row.acknowledgedOn ? `, ${row.acknowledgedOn}` : ''}): the Form ${form} extension for this return was rejected. ` +
              'Re-file the extension or record why not, then close this. No client message was sent.',
            assignedStaffId: owner, contactId: te.contact_id, priority: 1, source: 'automation', sourceType: 'efile_ack_review', sourceId: `${reportId}:${row.rowIndex}`,
          });
          taskId = t.id;
          disposition = 'task';
          note = `extension ${row.statusRaw} on ${returnLabel(te)}; task raised`;
          tasks++;
        } else {
          disposition = 'pending';
          note = `extension ${row.statusRaw} at ATX on ${returnLabel(te)}: pending, no action`;
          pending++;
        }
      }
    } else {
      /*
       * A RETURN ROW: only a return at 'filed' that still awaits this jurisdiction electronically.
       * Candidates at 'completed', or already accepted here, only explain a duplicate; they never match.
       */
      const code = jurisdictionCode(row);
      const types = row.formFamily ? returnTypesForFamily(row.formFamily) : null;
      const all = await candidates(app, ['filed', 'completed'], types, row.taxpayerLast4);
      const awaiting: Candidate[] = [];
      const alreadyAccepted: Candidate[] = [];
      for (const c of all) {
        const status = await acceptanceStatus(app, c.id);
        const method = status.rows.find((d) => d.jurisdiction === code)?.filingMethod ?? status.defaultFilingMethod;
        if (c.stage === 'filed' && status.awaiting.includes(code) && method === 'efile') awaiting.push(c);
        else if (status.accepted.includes(code)) alreadyAccepted.push(c);
      }
      const pick = tiebreak(row, awaiting);
      te = pick.te;
      if (!te) {
        // Already recorded: one return this identifier AND this name point at, accepted here before. Anything looser is unmatched.
        const dup = pick.why === 'none' && alreadyAccepted.length > 0 ? tiebreak(row, alreadyAccepted) : null;
        if (dup?.te && dup.nameAgrees) {
          te = dup.te;
          disposition = 'duplicate';
          note = `${where} acceptance already recorded on ${returnLabel(te)}`;
          duplicates++;
        } else {
          note = pick.why === 'none'
            ? `no SAOS return at filed awaits ${where} for a ${row.formRaw || 'return'} with this identifier; listed only`
            : pick.why;
        }
      } else if ((row.status === 'accepted' || row.status === 'rejected') && !pick.nameAgrees) {
        /*
         * MATCHED ON THE IDENTIFIER, BUT THE NAME DISAGREES. The last four, the form and the
         * jurisdiction say this return; the export's name says someone else, and four digits collide
         * across a firm-wide export more often than a name does. Nothing is applied and nothing is
         * sent: the row is HELD with the reason on it, and the return's preparer gets the task. An
         * unhold applies the acceptance and queues the notice; a rejection is applied by hand
         * through the manual door. The task names the return and the SAOS client, never the export's
         * name (persistence rule).
         */
        const owner = te.preparer_id ?? (await alertRecipientForRole(app.db, 'tax_preparer', 'efile_ack_name_disagrees'));
        const t = await createTask(app, {
          title: `E-file ${row.status === 'accepted' ? 'acknowledgment' : 'rejection'} held for review: ${where} on ${returnLabel(te)} for ${clientLabel(te)}`,
          description: `ATX export row ${row.rowIndex} (${row.statusRaw}${row.acknowledgedOn ? `, ${row.acknowledgedOn}` : ''}): the identifier's last four, the form and the jurisdiction match this return, ` +
            'but the name on the export does not agree with the SAOS record. Nothing was applied and nothing was sent. ' +
            (row.status === 'accepted'
              ? "If this acknowledgment is this return's, unhold the row on the E-file acks screen (that applies it and queues the client notice); otherwise leave it held. Then close this."
              : "If this rejection is this return's, record it through the return's E-file result control; otherwise leave the row as it is. Then close this."),
          assignedStaffId: owner, contactId: te.contact_id, priority: 1, source: 'automation', sourceType: 'efile_ack_review', sourceId: `${reportId}:${row.rowIndex}`,
        });
        taskId = t.id;
        disposition = row.status === 'accepted' ? 'held' : 'task';
        note = `matched ${returnLabel(te)} on identifier, form and jurisdiction, but the export's name does not agree with the record; held for review, nothing applied, nothing sent`;
        tasks++;
      } else if (row.status === 'accepted') {
        disposition = 'queued';
        queued++;
        const out = await applyAcceptance(app, actor, te.id, row, today);
        note = out.stage === 'completed'
          ? `matched ${returnLabel(te)}; accepted${withMessages}; the return is complete; will send when the report is released`
          : `matched ${returnLabel(te)}; accepted${withMessages}; will send when the report is released; the return still waits on ${out.awaiting.join(', ')}`;
      } else if (row.status === 'rejected') {
        // A rejection is never a client email. The existing owned path: task + perfection clock.
        await recordEfileResult(app, { staffId: actor.id, label: actor.label }, te.id, {
          result: 'rejected', rejectReason: `ATX status ${row.statusRaw}${row.acknowledgedOn ? ` on ${row.acknowledgedOn}` : ''} (report row ${row.rowIndex})`, today,
          jurisdiction: row.jurisdiction, stateCode: row.stateCode ?? undefined,
        });
        const t = await app.db.query<{ id: string }>(`SELECT id FROM tasks WHERE source_type = 'efile_reject' AND source_id = $1 ORDER BY created_at DESC LIMIT 1`, [te.id]);
        taskId = t.rows[0]?.id ?? null;
        disposition = 'task';
        note = `matched ${returnLabel(te)}; ${row.statusRaw} by ${where}; re-file task raised`;
        tasks++;
      } else {
        disposition = 'pending';
        note = row.status === 'pending'
          ? `matched ${returnLabel(te)}; ${row.statusRaw} at ATX: pending, no action`
          : `matched ${returnLabel(te)}; status "${row.statusRaw}" is not one SAOS knows: listed, no action`;
        pending++;
      }
    }
    if (disposition === 'unmatched') unmatched++;

    await app.db.query(
      `INSERT INTO efile_acknowledgments
         (report_id, row_index, tax_engagement_id, jurisdiction, state_code, status, status_raw, submission_id, acknowledged_on,
          client_name_raw, tax_year, return_type_raw, disposition, disposition_note, task_id,
          taxpayer_last4, sub_type, accepted_with_messages, status_at, extension_form)
       VALUES ($1,$2,$3,$4,$5,$6::efile_ack_status,$7,$8,$9,$10,$11,$12,$13::efile_ack_disposition,$14,$15,$16,$17,$18,$19,$20)`,
      [reportId, row.rowIndex, te?.id ?? null, row.jurisdiction, row.stateCode, row.status, row.statusRaw, row.submissionId, row.acknowledgedOn,
       row.nameRaw, te?.tax_year ?? null, row.formRaw || null, disposition, note, taskId,
       row.taxpayerLast4, row.subTypeRaw || null, row.acceptedWithMessages, row.statusAt, row.kind === 'extension' ? row.extensionForm : null]
    );
  }
  await app.db.query(
    `UPDATE efile_ack_reports SET matched_count = $2, task_count = $3, unmatched_count = $4, pending_count = $5, extension_count = $6 WHERE id = $1`,
    [reportId, queued, tasks, unmatched, pending, extensions]
  );
  await writeAudit(app.db, {
    actorType: 'staff', actorId: actor.id, actorLabel: actor.label,
    action: 'efile_ack.report_ingested', objectType: 'efile_ack_report', objectId: reportId,
    details: { filename: input.filename, sha256, rows: parsed.rows.length, queued, tasks, duplicates, unmatched, pending, extensions, skipped: parsed.skipped.length, identifiers_masked: true },
  });
  return { reportId, rows: parsed.rows.length, queued, tasks, duplicates, unmatched, pending, extensions, skipped: parsed.skipped, alreadyIngested: false };
}

export async function holdRow(app: FastifyInstance, actor: { id: string; label: string }, ackId: string, hold: boolean, today: string = todayChicago()): Promise<void> {
  const { rows } = await app.db.query<{
    disposition: string; report_id: string; status: string; tax_engagement_id: string | null; jurisdiction: Jurisdiction; state_code: string | null;
    acknowledged_on: string | null; submission_id: string | null; stage: string | null; withdrawn_at: Date | null;
  }>(
    `SELECT a.disposition::text AS disposition, a.report_id, a.status::text AS status, a.tax_engagement_id, a.jurisdiction::text AS jurisdiction, a.state_code,
            a.acknowledged_on::text AS acknowledged_on, a.submission_id, te.stage::text AS stage, r.withdrawn_at
       FROM efile_acknowledgments a
       JOIN efile_ack_reports r ON r.id = a.report_id
       LEFT JOIN tax_engagements te ON te.id = a.tax_engagement_id
      WHERE a.id = $1`, [ackId]);
  const r = rows[0];
  if (!r) throw new AppError(404, 'not_found', 'No such acknowledgment row.');
  if (r.withdrawn_at) throw new AppError(409, 'report_withdrawn', 'This report was withdrawn; its rows do not change.');
  if (hold && r.disposition !== 'queued') throw new AppError(409, 'not_queued', `Only a queued row can be held; this one is '${r.disposition}'.`);
  if (!hold && r.disposition !== 'held') throw new AppError(409, 'not_held', `This row is '${r.disposition}', not held.`);
  let applied = false;
  if (!hold && r.status === 'accepted' && r.tax_engagement_id && r.stage === 'filed') {
    /*
     * A ROW HELD FOR REVIEW AT INGEST (the name disagreed) has had nothing applied. The unhold is the
     * person saying "this is that return": apply the acceptance now, once. A row the preparer held
     * after it was applied is already stamped and is left alone.
     */
    const code = r.jurisdiction === 'federal' ? 'federal' : r.state_code!;
    const status = await acceptanceStatus(app, r.tax_engagement_id);
    if (status.awaiting.includes(code) && !status.accepted.includes(code)) {
      await applyAcceptance(app, actor, r.tax_engagement_id, { jurisdiction: r.jurisdiction, stateCode: r.state_code, acknowledgedOn: r.acknowledged_on, submissionId: r.submission_id }, today);
      applied = true;
    }
  }
  await app.db.query(
    `UPDATE efile_acknowledgments SET disposition = $2::efile_ack_disposition, held_by = $3, held_at = CASE WHEN $2::text = 'held' THEN now() ELSE NULL END,
            disposition_note = CASE WHEN $4 THEN 'unheld by ' || $5 || ': the acknowledgment was applied to the return; will send when the report is released' ELSE disposition_note END
      WHERE id = $1`,
    [ackId, hold ? 'held' : 'queued', hold ? actor.id : null, applied, actor.label]
  );
  await writeAudit(app.db, { actorType: 'staff', actorId: actor.id, actorLabel: actor.label, action: hold ? 'efile_ack.row_held' : 'efile_ack.row_released', objectType: 'efile_ack', objectId: ackId, details: { report_id: r.report_id, applied_on_unhold: applied } });
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
 * It releases ONLY matched accepted rows ('queued'): unmatched, pending, rejected and extension rows
 * have nothing to send.
 */
export async function releaseReport(app: FastifyInstance, actor: { id: string; label: string }, reportId: string): Promise<{ enqueued: number; held: number }> {
  const rep = await app.db.query<{ id: string; released_at: Date | null; withdrawn_at: Date | null }>(`SELECT id, released_at, withdrawn_at FROM efile_ack_reports WHERE id = $1`, [reportId]);
  if (!rep.rows[0]) throw new AppError(404, 'not_found', 'No such report.');
  if (rep.rows[0].withdrawn_at) throw new AppError(409, 'report_withdrawn', 'This report was withdrawn; nothing on it sends. Upload the file again if it should.');
  const { rows } = await app.db.query<{ id: string; tax_engagement_id: string; contact_id: string }>(
    `SELECT a.id, a.tax_engagement_id, e.contact_id
       FROM efile_acknowledgments a
       JOIN tax_engagements te ON te.id = a.tax_engagement_id
       JOIN engagements e ON e.id = te.engagement_id
      WHERE a.report_id = $1 AND a.disposition = 'queued' AND a.status = 'accepted'`,
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

/**
 * THE PROPOSAL BECOMES A RECORD (R43 → R12). The preparer reviewed the extension row and records it:
 * the Record extension door, with the form the export named and the status date as the date filed.
 * The return then carries its extension and its derived deadline exactly as if the row had been
 * typed. Nothing is emailed.
 */
export async function recordProposedExtension(
  app: FastifyInstance,
  actor: { id: string; label: string },
  ackId: string,
  today: string = todayChicago()
): Promise<{ extendedDeadline: string | null; form: ExtensionForm; filedOn: string }> {
  const { rows } = await app.db.query<{ disposition: string; tax_engagement_id: string | null; extension_form: ExtensionForm | null; acknowledged_on: string | null; report_id: string; extension_filed: boolean | null; withdrawn_at: Date | null }>(
    `SELECT a.disposition::text AS disposition, a.tax_engagement_id, a.extension_form, a.acknowledged_on::text AS acknowledged_on, a.report_id,
            te.extension_filed, r.withdrawn_at
       FROM efile_acknowledgments a
       JOIN efile_ack_reports r ON r.id = a.report_id
       LEFT JOIN tax_engagements te ON te.id = a.tax_engagement_id
      WHERE a.id = $1`, [ackId]);
  const a = rows[0];
  if (!a) throw new AppError(404, 'not_found', 'No such acknowledgment row.');
  if (a.withdrawn_at) throw new AppError(409, 'report_withdrawn', 'This report was withdrawn; nothing on it is recorded.');
  if (a.disposition !== 'extension_proposed' || !a.tax_engagement_id || !a.extension_form) {
    throw new AppError(409, 'not_an_extension_proposal', `Only a proposed extension can be recorded; this row is '${a.disposition}'.`);
  }
  if (a.extension_filed) throw new AppError(409, 'extension_already_recorded', 'An extension is already recorded on this return.');
  const out = await markExtensionFiled(app, { staffId: actor.id, label: actor.label }, a.tax_engagement_id, today, {
    form: a.extension_form, filedOn: a.acknowledged_on ?? today,
  });
  await app.db.query(`UPDATE efile_acknowledgments SET disposition = 'extension_recorded', disposition_note = $2 WHERE id = $1`,
    [ackId, `Form ${out.form} extension recorded on the return, filed ${out.filedOn}; extended deadline ${out.extendedDeadline ?? 'not derived'}`]);
  await writeAudit(app.db, {
    actorType: 'staff', actorId: actor.id, actorLabel: actor.label, action: 'efile_ack.extension_recorded', objectType: 'efile_ack', objectId: ackId,
    details: { report_id: a.report_id, tax_engagement_id: a.tax_engagement_id, form: out.form, filed_on: out.filedOn, extended_deadline: out.extendedDeadline },
  });
  return out;
}

/**
 * THE WITHDRAW DOOR (R43). A report is void: its queued rows never send, its release is refused, and
 * its file may be uploaded again (the content-hash uniqueness is among live reports only). The rows
 * stay — what an upload did is a record — and so do any acceptances it stamped, because an acceptance
 * is a fact and not a preference. An actor with no id is the system, named in the label.
 */
export async function withdrawReport(
  app: FastifyInstance,
  actor: { id: string | null; label: string },
  reportId: string,
  reason: string
): Promise<{ queuedVoided: number }> {
  const why = reason.trim();
  if (!why) throw new AppError(400, 'reason_required', 'Say why the report is withdrawn.');
  const rep = await app.db.query<{ id: string; withdrawn_at: Date | null; filename: string }>(`SELECT id, withdrawn_at, filename FROM efile_ack_reports WHERE id = $1`, [reportId]);
  if (!rep.rows[0]) throw new AppError(404, 'not_found', 'No such report.');
  if (rep.rows[0].withdrawn_at) throw new AppError(409, 'already_withdrawn', 'This report was already withdrawn.');
  const queued = await app.db.query<{ n: string }>(`SELECT count(*) AS n FROM efile_acknowledgments WHERE report_id = $1 AND disposition IN ('queued', 'held')`, [reportId]);
  await app.db.query(`UPDATE efile_ack_reports SET withdrawn_at = now(), withdrawn_by = $2, withdrawn_reason = $3 WHERE id = $1`, [reportId, actor.id, why]);
  const queuedVoided = Number(queued.rows[0]!.n);
  await writeAudit(app.db, {
    actorType: actor.id ? 'staff' : 'system', actorId: actor.id, actorLabel: actor.label,
    action: 'efile_ack.report_withdrawn', objectType: 'efile_ack_report', objectId: reportId,
    details: { filename: rep.rows[0].filename, reason: why, queued_rows_voided: queuedVoided },
  });
  return { queuedVoided };
}

export interface PurgeResult {
  rawFileIdentifiers: number;
  ackRowsRewritten: number;
  tasksRewritten: number;
  /** Counted, never rewritten: the audit log is append-only. Zero is the expected value. */
  auditRowsHoldingIdentifiers: number;
}

/**
 * THE PURGE DOOR (R43). Every full identifier a report persisted — in the stored file, on its rows,
 * in the tasks it raised — rewritten to its last four, and the counts on an audit row. The parser
 * has masked at ingest since R43; this is for what was uploaded before, and it is idempotent.
 */
export async function purgeReportIdentifiers(
  app: FastifyInstance,
  actor: { id: string | null; label: string },
  reportId: string
): Promise<PurgeResult> {
  const rep = await app.db.query<{ raw_text: string; filename: string }>(`SELECT raw_text, filename FROM efile_ack_reports WHERE id = $1`, [reportId]);
  if (!rep.rows[0]) throw new AppError(404, 'not_found', 'No such report.');
  const rawFileIdentifiers = (rep.rows[0].raw_text.match(IDENTIFIER) ?? []).length;
  if (rawFileIdentifiers > 0) {
    await app.db.query(`UPDATE efile_ack_reports SET raw_text = $2 WHERE id = $1`, [reportId, maskIdentifiers(rep.rows[0].raw_text)]);
  }

  const acks = await app.db.query<{ id: string; client_name_raw: string; disposition_note: string; status_raw: string; submission_id: string | null; reject_code: string | null; reject_reason: string | null }>(
    `SELECT id, client_name_raw, disposition_note, status_raw, submission_id, reject_code, reject_reason
       FROM efile_acknowledgments
      WHERE report_id = $1
        AND concat_ws(' ', client_name_raw, disposition_note, status_raw, submission_id, reject_code, reject_reason) ~ $2`,
    [reportId, IDENTIFIER_SQL]
  );
  for (const a of acks.rows) {
    const m = (s: string | null) => (s === null ? null : maskIdentifiers(s));
    await app.db.query(
      `UPDATE efile_acknowledgments SET client_name_raw = $2, disposition_note = $3, status_raw = $4, submission_id = $5, reject_code = $6, reject_reason = $7 WHERE id = $1`,
      [a.id, maskIdentifiers(a.client_name_raw), maskIdentifiers(a.disposition_note), maskIdentifiers(a.status_raw), m(a.submission_id), m(a.reject_code), m(a.reject_reason)]
    );
  }

  const tasks = await app.db.query<{ id: string; title: string; description: string | null }>(
    `SELECT id, title, description FROM tasks
      WHERE source_type = 'efile_ack_review' AND source_id LIKE $1 AND concat_ws(' ', title, description) ~ $2`,
    [`${reportId}:%`, IDENTIFIER_SQL]
  );
  for (const t of tasks.rows) {
    await app.db.query(`UPDATE tasks SET title = $2, description = $3, updated_at = now() WHERE id = $1`,
      [t.id, maskIdentifiers(t.title), t.description === null ? null : maskIdentifiers(t.description)]);
  }

  const audit = await app.db.query<{ n: string }>(
    `SELECT count(*) AS n FROM audit_log
      WHERE ((object_type = 'efile_ack_report' AND object_id = $1)
          OR (object_type = 'efile_ack' AND object_id IN (SELECT id::text FROM efile_acknowledgments WHERE report_id = $1::uuid)))
        AND details::text ~ $2`,
    [reportId, IDENTIFIER_SQL]
  );
  const result: PurgeResult = {
    rawFileIdentifiers, ackRowsRewritten: acks.rows.length, tasksRewritten: tasks.rows.length, auditRowsHoldingIdentifiers: Number(audit.rows[0]!.n),
  };
  await writeAudit(app.db, {
    actorType: actor.id ? 'staff' : 'system', actorId: actor.id, actorLabel: actor.label,
    action: 'efile_ack.identifiers_purged', objectType: 'efile_ack_report', objectId: reportId,
    details: { filename: rep.rows[0].filename, raw_file_identifiers_masked: result.rawFileIdentifiers, ack_rows_rewritten: result.ackRowsRewritten, tasks_rewritten: result.tasksRewritten, audit_rows_holding_identifiers: result.auditRowsHoldingIdentifiers },
  });
  return result;
}

/** The outbox handler for `efile.ack_notice`. Gated. Federal and state are different messages. */
export async function sendEfileAckNotice(app: FastifyInstance, ackId: string): Promise<{ sent: boolean; reason?: string }> {
  const { rows } = await app.db.query<{
    id: string; disposition: string; jurisdiction: Jurisdiction; state_code: string | null; acknowledged_on: string | null;
    tax_year: number; return_type: string; contact_id: string; first_name: string; email: string | null; language: 'en' | 'es';
    released_by: string | null; released_by_name: string | null; withdrawn_at: Date | null;
  }>(
    `SELECT a.id, a.disposition::text AS disposition, a.jurisdiction::text AS jurisdiction, a.state_code, a.acknowledged_on::text AS acknowledged_on,
            te.tax_year, te.return_type::text AS return_type, e.contact_id, c.first_name, c.email, c.language,
            r.released_by, rl.full_name AS released_by_name, r.withdrawn_at
       FROM efile_acknowledgments a
       JOIN efile_ack_reports r ON r.id = a.report_id
       LEFT JOIN staff rl ON rl.id = r.released_by
       JOIN tax_engagements te ON te.id = a.tax_engagement_id
       JOIN engagements e ON e.id = te.engagement_id
       JOIN contacts c ON c.id = e.contact_id
      WHERE a.id = $1`,
    [ackId]
  );
  const a = rows[0];
  if (!a) return { sent: false, reason: 'ack not found' };
  if (a.withdrawn_at) return { sent: false, reason: 'report_withdrawn' };
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
  /*
   * THE ACTOR ON THE SEND IS THE PERSON WHO RELEASED IT (Brian, 2026-09-19): the outbox carries
   * the message, it does not decide to send it. The release decision names a person and so does
   * every email it caused.
   */
  await writeAudit(app.db, {
    actorType: a.released_by ? 'staff' : 'system', actorId: a.released_by, actorLabel: a.released_by_name ?? 'outbox',
    action: 'efile_ack.notice_sent', objectType: 'efile_ack', objectId: ackId, contactId: a.contact_id,
    details: { template: templateKey, jurisdiction: a.jurisdiction, state_code: a.state_code, tax_year: a.tax_year, language: a.language, released_by: a.released_by },
  });
  return { sent: true };
}

const REPORT_COLUMNS = `r.id, r.filename, r.uploaded_at, r.released_at, r.withdrawn_at, r.withdrawn_reason,
            r.row_count, r.matched_count, r.task_count, r.unmatched_count, r.pending_count, r.extension_count,
            (r.raw_text ~ '${IDENTIFIER_SQL}') AS holds_identifiers`;

export async function reportView(app: FastifyInstance, reportId: string) {
  const rep = await app.db.query(
    `SELECT ${REPORT_COLUMNS}, u.full_name AS uploaded_by, rl.full_name AS released_by, w.full_name AS withdrawn_by
       FROM efile_ack_reports r
       JOIN staff u ON u.id = r.uploaded_by
       LEFT JOIN staff rl ON rl.id = r.released_by
       LEFT JOIN staff w ON w.id = r.withdrawn_by
      WHERE r.id = $1`, [reportId]);
  if (!rep.rows[0]) throw new AppError(404, 'not_found', 'No such report.');
  const rows = await app.db.query(
    `SELECT a.id, a.row_index, a.jurisdiction::text AS jurisdiction, a.state_code, a.status::text AS status, a.status_raw, a.accepted_with_messages,
            a.submission_id, a.acknowledged_on::text AS acknowledged_on, a.status_at, a.reject_code, a.client_name_raw, a.taxpayer_last4, a.sub_type, a.extension_form,
            a.tax_year, a.return_type_raw,
            a.disposition::text AS disposition, a.disposition_note, a.task_id, a.sent_at,
            (SELECT max(al.occurred_at) FROM audit_log al WHERE al.object_type = 'efile_ack' AND al.object_id = a.id::text AND al.action = 'efile_ack.notice_suppressed') AS suppressed_at,
            te.id AS tax_engagement_id, te.return_type::text AS return_type, c.id AS contact_id,
            COALESCE(b.name, c.first_name || ' ' || c.last_name) AS client, c.language
       FROM efile_acknowledgments a
       LEFT JOIN tax_engagements te ON te.id = a.tax_engagement_id
       LEFT JOIN engagements e ON e.id = te.engagement_id
       LEFT JOIN contacts c ON c.id = e.contact_id
       LEFT JOIN businesses b ON b.id = e.business_id
      WHERE a.report_id = $1 ORDER BY a.row_index`, [reportId]);
  return { report: rep.rows[0], rows: rows.rows };
}

export async function listReports(app: FastifyInstance) {
  const { rows } = await app.db.query(
    `SELECT ${REPORT_COLUMNS}, u.full_name AS uploaded_by
       FROM efile_ack_reports r JOIN staff u ON u.id = r.uploaded_by ORDER BY r.uploaded_at DESC LIMIT 50`);
  return rows;
}
