// M22 source adapters: read the raw exports (Dubsado CSVs, Zoho backup CSVs,
// Grant Tracker workbook) into normalized shapes. Parsing only — the
// include/skip/dedupe rules live in plan.ts.
//
// PII discipline: nothing in here logs row data. Grant-tracker Login Details
// are separated from grant rows AT PARSE TIME so credentials can never leak
// into the grants table, import_records, or the report (CLAUDE.md; Brian's
// instruction; grants_received table comment).

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { parseCsvObjects } from './csv.ts';

// ── normalized shapes ────────────────────────────────────────────────────────

export interface DubsadoClient {
  sourceRef: string; // dubsado has no export id — lowercased email, or name slug
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  addressLine1: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  company: string | null;      // from projects — business-name billing link
  title: string | null;
  startDate: string | null;    // ISO date
  lastActivity: string | null; // max(start, projects by email, invoices/transactions by name)
  invoiceCount: number;
  projectCount: number;
  raw: Record<string, string>;
}

export interface ZohoContact {
  sourceRef: string; // Zoho Record Id
  firstName: string;
  lastName: string;
  email: string | null;
  secondaryEmail: string | null;
  phone: string | null;
  secondaryPhone: string | null;
  addressLine1: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  description: string | null;
  accountRef: string | null;   // Account Name.id
  tag: string | null;
  createdAt: string | null;
  lastActivity: string | null; // max(Modified Time, Last Activity Time)
  raw: Record<string, string>;
}

export interface ZohoAccount {
  sourceRef: string;
  name: string;
  dba: string | null;
  ein: string | null;
  entityRaw: string | null;
  entityType: string | null;   // normalized to business_entity_type, or null
  industry: string | null;
  irsBusinessCode: string | null;
  website: string | null;
  phone: string | null;
  email: string | null;
  state: string | null;
  zip: string | null;
  formationDate: string | null;
  fileNumber: string | null;
  registeredAgent: string | null;
  lastActivity: string | null;
  raw: Record<string, string>;
}

export interface ZohoLead {
  sourceRef: string;
  firstName: string;
  lastName: string;
  company: string | null;
  email: string | null;
  phone: string | null;
  isConverted: boolean;
  lastActivity: string | null;
  raw: Record<string, string>;
}

export interface GrantRow {
  sheetYear: number | null;
  funder: string;
  program: string | null;
  statusRaw: string | null;
  amountRaw: string | null;
  amountCents: number | null;
  submissionTypeRaw: string | null;
  leadRaw: string | null;
  internalDeadline: string | null;
  hardDeadline: string | null;
  dateReceived: string | null;
  materialsLink: string | null;
  timeframe: string | null;
  notes: string | null;
  hadCredentials: boolean;
  /** Original row with Login Details columns REPLACED by a routing marker. */
  raw: Record<string, string>;
}

export interface CredentialItem {
  grantName: string;
  sheetYear: number | null;
  username: string | null;
  password: string | null;
  /** 2023 sheet kept user/email/password in ONE cell — needs a manual split. */
  combined: string | null;
  materialsLink: string | null;
}

// ── small helpers ────────────────────────────────────────────────────────────

const MONTHS = new Set([
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
]);

export function normalizePhone(value: string | null | undefined): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, '');
  if (digits.length < 7) return null;
  return digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
}

/** Tolerant date parsing: ISO, "YYYY-MM-DD hh:mm:ss" (Zoho), M/D/YYYY, "Mon D, YYYY". */
export function parseDateish(value: string | null | undefined): string | null {
  if (!value) return null;
  const t = value.trim();
  if (t === '') return null;
  let d: Date | null = null;
  if (/^\d{4}-\d{2}-\d{2}([ T]|$)/.test(t)) {
    d = new Date(t.replace(' ', 'T'));
  } else if (/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(t)) {
    const [m, day, y] = t.split('/').map(Number);
    d = new Date(Date.UTC(y! < 100 ? 2000 + y! : y!, m! - 1, day!));
  } else {
    const parsed = new Date(t);
    d = Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  if (!d || Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

export function moneyToCents(value: string | null | undefined): number | null {
  if (!value) return null;
  const m = value.replace(/[,$\s]/g, '').match(/^-?\d+(\.\d{1,2})?$/);
  if (!m) return null;
  return Math.round(Number(m[0]) * 100);
}

function blankToNull(v: string | undefined): string | null {
  const t = (v ?? '').trim();
  return t === '' ? null : t;
}

function maxIso(...dates: Array<string | null>): string | null {
  const real = dates.filter((d): d is string => d !== null);
  return real.length === 0 ? null : real.sort().at(-1)!;
}

/** Zoho custom "Entity" strings → business_entity_type enum (null if unknown). */
export function normalizeEntityType(raw: string | null): string | null {
  if (!raw) return null;
  const t = raw.toLowerCase().replace(/[.\s-]/g, '');
  if (t.includes('pllc')) return 'pllc';
  if (t.includes('llc')) return 'llc';
  if (t.includes('scorp') || t === 's') return 's_corp';
  if (t.includes('ccorp')) return 'c_corp';
  if (t === 'corp' || t === 'corporation' || t.includes('inc')) return 'c_corp';
  if (t.includes('soleprop') || t.includes('sole')) return 'sole_prop';
  if (t.includes('partner')) return 'partnership';
  if (t.includes('nonprofit') || t.includes('notforprofit') || t === 'nfp' || t.includes('501')) return 'nonprofit';
  if (t.includes('coop')) return 'coop';
  return null;
}

// ── Dubsado ──────────────────────────────────────────────────────────────────

/** First file in dir whose name matches (case-insensitive) — Dubsado exports arrive with varying names. */
async function findFile(dir: string, pattern: RegExp): Promise<string | null> {
  const { readdir } = await import('node:fs/promises');
  const hit = (await readdir(dir)).find((f) => pattern.test(f));
  return hit ? path.join(dir, hit) : null;
}

export async function parseDubsado(dir: string): Promise<{
  clients: DubsadoClient[];
  invoiceRows: number;
  projectRows: number;
  invoicesUnmatched: number;
  /** Invoice "Client" names with no client row — often business-name billing; review list. */
  unmatchedInvoiceClients: string[];
  /** Project client emails absent from the client roster — review list. */
  projectEmailsNotInRoster: string[];
}> {
  const clientsPath = await findFile(dir, /clients.*\.csv$/i);
  if (!clientsPath) throw new Error(`no *clients*.csv in ${dir}`);
  const clientRows = parseCsvObjects(await readFile(clientsPath, 'utf8'));

  // Optional companions: invoices, transactions (both keyed by display name),
  // projects (keyed by CLIENT EMAIL — the reliable join).
  const readOptional = async (pattern: RegExp) => {
    const p = await findFile(dir, pattern);
    return p ? parseCsvObjects(await readFile(p, 'utf8')) : [];
  };
  const invoiceRows = await readOptional(/invoices.*\.csv$/i);
  const transactionRows = await readOptional(/transactions.*\.csv$/i);
  const projectRows = await readOptional(/projects.*\.csv$/i);

  // Latest activity per client display name ("First Last", lowercased).
  const byName = new Map<string, { date: string | null; count: number }>();
  const touchName = (name: string | undefined, date: string | null, countInvoice: boolean) => {
    const key = (name ?? '').trim().toLowerCase();
    if (key === '') return;
    const prev = byName.get(key) ?? { date: null, count: 0 };
    byName.set(key, { date: maxIso(prev.date, date), count: prev.count + (countInvoice ? 1 : 0) });
  };
  for (const inv of invoiceRows) {
    const dates = [parseDateish(inv['Date'])];
    for (const p of (inv['Payment Date(s)'] ?? '').split(/[,;]/)) dates.push(parseDateish(p));
    touchName(inv['Client'], maxIso(...dates), true);
  }
  for (const t of transactionRows) {
    touchName(t['invoiceClient'], maxIso(parseDateish(t['date']), parseDateish(t['invoicePaidDate'])), false);
  }

  // Projects: per-email activity + company + split address.
  interface ProjectAgg {
    date: string | null;
    count: number;
    company: string | null;
    addressLine1: string | null;
    city: string | null;
    state: string | null;
    zip: string | null;
    phone: string | null;
  }
  const byEmail = new Map<string, ProjectAgg>();
  for (const p of projectRows) {
    const email = blankToNull(p['Client email'])?.toLowerCase();
    const date = maxIso(parseDateish(p['Created date']), parseDateish(p['Start date']));
    if (email) {
      const prev = byEmail.get(email) ?? {
        date: null, count: 0, company: null, addressLine1: null, city: null, state: null, zip: null, phone: null,
      };
      byEmail.set(email, {
        date: maxIso(prev.date, date),
        count: prev.count + 1,
        company: prev.company ?? blankToNull(p['Company name']) ?? blankToNull(p['Company']),
        addressLine1: prev.addressLine1 ?? blankToNull(p['Client address Line 1']),
        city: prev.city ?? blankToNull(p['Client address City']),
        state: prev.state ?? blankToNull(p['Client address State']),
        zip: prev.zip ?? blankToNull(p['Client address Zip']),
        phone: prev.phone ?? blankToNull(p['Client phone']),
      });
    } else {
      // No email on the project → fall back to the contact display name.
      touchName(p['Contact name'] ?? p['Client first name'], date, false);
    }
  }

  const clients = clientRows.map((row): DubsadoClient => {
    const firstName = (row['firstName'] ?? '').trim();
    const lastName = (row['lastName'] ?? '').trim();
    const email = blankToNull(row['email'])?.toLowerCase() ?? null;
    const named = byName.get(`${firstName} ${lastName}`.trim().toLowerCase());
    const proj = email ? byEmail.get(email) : undefined;
    const startDate = parseDateish(row['start']);
    return {
      sourceRef: email ?? `dubsado:${firstName} ${lastName}`.toLowerCase(),
      firstName: firstName || '(unknown)',
      lastName: lastName || '(unknown)',
      email,
      phone: blankToNull(row['phone']) ?? proj?.phone ?? null,
      addressLine1: proj?.addressLine1 ?? blankToNull(row['addressString']),
      city: proj?.city ?? null,
      state: proj?.state ?? null,
      zip: proj?.zip ?? null,
      company: proj?.company ?? null,
      title: blankToNull(row['title']),
      startDate,
      lastActivity: maxIso(startDate, named?.date ?? null, proj?.date ?? null),
      invoiceCount: named?.count ?? 0,
      projectCount: proj?.count ?? 0,
      raw: row,
    };
  });

  const rosterNames = new Set(clients.map((c) => `${c.firstName} ${c.lastName}`.toLowerCase()));
  const rosterEmails = new Set(clients.map((c) => c.email).filter((e): e is string => e !== null));
  return {
    clients,
    invoiceRows: invoiceRows.length,
    projectRows: projectRows.length,
    invoicesUnmatched: [...byName.keys()].filter((k) => !rosterNames.has(k)).length,
    unmatchedInvoiceClients: [...byName.keys()].filter((k) => !rosterNames.has(k)).sort(),
    projectEmailsNotInRoster: [...byEmail.keys()].filter((e) => !rosterEmails.has(e)).sort(),
  };
}

// ── Zoho ─────────────────────────────────────────────────────────────────────

export async function parseZoho(dir: string): Promise<{
  contacts: ZohoContact[];
  accounts: ZohoAccount[];
  leads: ZohoLead[];
  links: Array<{ contactRef: string; accountRef: string }>;
}> {
  const dataDir = path.join(dir, 'zoho-extracted', 'Data');
  const read = async (file: string) => parseCsvObjects(await readFile(path.join(dataDir, file), 'utf8'));

  const contacts = (await read('Contacts_001.csv')).map((row): ZohoContact => {
    const phones = [row['Phone'], row['Mobile'], row['Home Phone'], row['Other Phone']]
      .map(blankToNull)
      .filter((p): p is string => p !== null);
    return {
      sourceRef: (row['Record Id'] ?? '').trim(),
      firstName: (row['First Name'] ?? '').trim() || '(unknown)',
      lastName: (row['Last Name'] ?? '').trim() || '(unknown)',
      email: blankToNull(row['Email'])?.toLowerCase() ?? null,
      secondaryEmail: blankToNull(row['Secondary Email'])?.toLowerCase() ?? null,
      phone: phones[0] ?? null,
      secondaryPhone: phones[1] ?? null,
      addressLine1: blankToNull(row['Mailing Street']),
      city: blankToNull(row['Mailing City']),
      state: blankToNull(row['Mailing State']),
      zip: blankToNull(row['Mailing Zip']),
      description: blankToNull(row['Description']),
      accountRef: blankToNull(row['Account Name.id']),
      tag: blankToNull(row['Tag']),
      createdAt: parseDateish(row['Created Time']),
      lastActivity: maxIso(parseDateish(row['Modified Time']), parseDateish(row['Last Activity Time'])),
      raw: row,
    };
  });

  const accounts = (await read('Accounts_001.csv')).map((row): ZohoAccount => {
    const entityRaw = blankToNull(row['Entity']);
    return {
      sourceRef: (row['Record Id'] ?? '').trim(),
      name: (row['Account Name'] ?? '').trim() || '(unnamed)',
      dba: blankToNull(row['DBA']),
      ein: blankToNull(row['EIN']),
      entityRaw,
      entityType: normalizeEntityType(entityRaw),
      industry: blankToNull(row['Industry']),
      irsBusinessCode: blankToNull(row['IRS Business Codes']),
      website: blankToNull(row['Website']),
      phone: blankToNull(row['Phone']),
      email: blankToNull(row['Email'])?.toLowerCase() ?? null,
      state: blankToNull(row['Billing State']) ?? blankToNull(row['State']),
      zip: blankToNull(row['Billing Code']),
      formationDate: parseDateish(row['Formation Date']),
      fileNumber: blankToNull(row['File Number']),
      registeredAgent: blankToNull(row['Registered Agent']),
      lastActivity: maxIso(parseDateish(row['Modified Time']), parseDateish(row['Last Activity Time'])),
      raw: row,
    };
  });

  const leads = (await read('Leads_001.csv')).map((row): ZohoLead => ({
    sourceRef: (row['Record Id'] ?? '').trim(),
    firstName: (row['First Name'] ?? '').trim() || '(unknown)',
    lastName: (row['Last Name'] ?? '').trim() || '(unknown)',
    company: blankToNull(row['Company']),
    email: blankToNull(row['Email'])?.toLowerCase() ?? null,
    phone: blankToNull(row['Phone']) ?? blankToNull(row['Mobile']),
    isConverted: (row['Is Converted'] ?? '').trim().toLowerCase() === 'true',
    lastActivity: maxIso(parseDateish(row['Modified Time']), parseDateish(row['Last Activity Time'])),
    raw: row,
  }));

  // contact↔account links: the contact's own Account Name.id plus the
  // many-to-many junction module.
  const links: Array<{ contactRef: string; accountRef: string }> = [];
  for (const c of contacts) {
    if (c.accountRef) links.push({ contactRef: c.sourceRef, accountRef: c.accountRef });
  }
  for (const row of await read('Contacts X Accounts_C_001.csv')) {
    const accountRef = blankToNull(row['Accounts.id']);
    const contactRef = blankToNull(row['Multi-Select Lookup 1.id']);
    if (accountRef && contactRef) links.push({ contactRef, accountRef });
  }

  return { contacts, accounts, leads, links };
}

// ── Grant Tracker (xlsx) ─────────────────────────────────────────────────────

type CellValue = ExcelJS.CellValue;

function cellText(value: CellValue): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    if ('richText' in value) return value.richText.map((r) => r.text).join('');
    if ('hyperlink' in value) return String(value.text ?? value.hyperlink ?? '');
    if ('result' in value) return cellText(value.result as CellValue);
    if ('error' in value) return '';
  }
  return String(value).trim();
}

function cellLink(value: CellValue): string | null {
  if (value !== null && typeof value === 'object' && 'hyperlink' in value) {
    return String(value.hyperlink);
  }
  const t = cellText(value);
  return /^https?:\/\//i.test(t) ? t : null;
}

const CRED_MARKER = '[routed-to-vaultwarden]';

export async function parseGrantTracker(filePath: string): Promise<{
  grants: GrantRow[];
  credentials: CredentialItem[];
  sheets: Array<{ name: string; dataRows: number; sectionRows: number }>;
}> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);

  const grants: GrantRow[] = [];
  const credentials: CredentialItem[] = [];
  const sheets: Array<{ name: string; dataRows: number; sectionRows: number }> = [];

  for (const ws of wb.worksheets) {
    if (ws.state !== 'visible') continue;
    const sheetYear = ws.name.match(/(\d{4})/) ? Number(ws.name.match(/(\d{4})/)![1]) : null;

    // Header map: normalized header text → column number.
    const headers = new Map<string, number>();
    ws.getRow(1).eachCell({ includeEmpty: false }, (cell, col) => {
      const key = cellText(cell.value).toLowerCase().replace(/\s+/g, ' ').trim();
      if (key !== '' && !headers.has(key)) headers.set(key, col);
    });
    const col = (pred: (h: string) => boolean): number | null => {
      for (const [h, c] of headers) if (pred(h)) return c;
      return null;
    };

    const cName = col((h) => h === 'name');
    if (cName === null) continue; // not a tracker sheet
    const cStatus = col((h) => h.startsWith('status'));
    const cInternal = col((h) => h.includes('internal deadline'));
    const cDeadline = col((h) => h === 'deadline');
    const cLead = col((h) => h === 'lead');
    const cType = col((h) => h.includes('submission type'));
    const cProgram = col((h) => h === 'program');
    const cAmount = col((h) => h.includes('grant amount'));
    const cLink = col((h) => h.includes('funding materials'));
    const cReceived = col((h) => h.includes('date received'));
    const cNotes = col((h) => h === 'notes');
    const cTimeframe = col((h) => h.includes('timeframe')); // headers are lowercased, so the 2023 'TImeframe' typo matches too
    // Login Details columns: split (2024/2025) or combined (2023).
    const credCols: Array<{ col: number; kind: 'username' | 'password' | 'combined' }> = [];
    for (const [h, c] of headers) {
      if (!h.includes('login details')) continue;
      if (h.includes('password') && (h.includes('username') || h.includes('email'))) {
        credCols.push({ col: c, kind: 'combined' });
      } else if (h.includes('password')) {
        credCols.push({ col: c, kind: 'password' });
      } else {
        credCols.push({ col: c, kind: 'username' });
      }
    }

    let dataRows = 0;
    let sectionRows = 0;
    for (let r = 2; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const at = (c: number | null): string => (c === null ? '' : cellText(row.getCell(c).value));
      const name = at(cName);
      if (name === '') continue;

      const meaningful =
        [cStatus, cProgram, cAmount, cDeadline, cInternal, cReceived, cNotes, cType]
          .some((c) => at(c) !== '') || credCols.some(({ col: c }) => at(c) !== '');
      // Month labels / bare section markers ("January", "Q2", "FY23"…): a
      // name-only row with nothing else on it.
      if (!meaningful || MONTHS.has(name.toLowerCase())) {
        sectionRows++;
        continue;
      }
      dataRows++;

      // Credentials FIRST — then build the grant row without them.
      let username: string | null = null;
      let password: string | null = null;
      let combined: string | null = null;
      for (const { col: c, kind } of credCols) {
        const v = at(c);
        if (v === '') continue;
        if (kind === 'username') username = v;
        else if (kind === 'password') password = v;
        else combined = v;
      }
      const materialsLink = cLink === null ? null : cellLink(row.getCell(cLink).value) ?? blankToNull(at(cLink));
      const hadCredentials = username !== null || password !== null || combined !== null;
      if (hadCredentials) {
        credentials.push({ grantName: name, sheetYear, username, password, combined, materialsLink });
      }

      // Traceability copy with credentials REPLACED, never stored.
      const raw: Record<string, string> = {};
      for (const [h, c] of headers) {
        const isCred = credCols.some((cc) => cc.col === c);
        const v = at(c);
        if (v !== '') raw[h] = isCred ? CRED_MARKER : v;
      }

      const amountRaw = blankToNull(at(cAmount));
      grants.push({
        sheetYear,
        funder: name,
        program: blankToNull(at(cProgram)),
        statusRaw: blankToNull(at(cStatus)),
        amountRaw,
        amountCents: moneyToCents(amountRaw),
        submissionTypeRaw: blankToNull(at(cType)),
        leadRaw: blankToNull(at(cLead)),
        internalDeadline: parseDateish(at(cInternal)),
        hardDeadline: parseDateish(at(cDeadline)),
        dateReceived: parseDateish(at(cReceived)),
        materialsLink,
        timeframe: blankToNull(at(cTimeframe)),
        notes: blankToNull(at(cNotes)),
        hadCredentials,
        raw,
      });
    }
    sheets.push({ name: ws.name.trim(), dataRows, sectionRows });
  }

  return { grants, credentials, sheets };
}
