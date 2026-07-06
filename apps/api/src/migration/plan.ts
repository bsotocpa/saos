// M22 rule engine: turns parsed sources into an ImportPlan. Pure — no I/O,
// no DB — so every rule is unit-testable and the dry run is EXACTLY the run.
//
// Rules (MP Data Migration):
//  - Dubsado: clients active within the window (default 36mo). ≤24mo →
//    soto 'active'; 24–36mo → 'inactive'; older/undated → skipped.
//  - Zoho: full import, but skip records inactive 36mo+ unless tagged.
//    Zoho-only people arrive as 'lead' (Dubsado, the client system of
//    record, is what proves clienthood). Unconverted Zoho Leads → 'lead'.
//  - Dedupe: email first, then normalized phone. Merge = fill-don't-overwrite
//    (Dubsado identity wins, Zoho enriches). Same-name-no-contact-info pairs
//    are only FLAGGED for review — never auto-merged.
//  - Businesses: a Zoho account imports when a linked contact imports AND it
//    looks like a real business (EIN/entity/DBA/industry present, or its
//    name isn't just the person's name).
//  - Grants: every tracker row → grants_received; Login Details NEVER enter
//    the plan's grant rows (stripped at parse); they ride separately to the
//    Vaultwarden export.

import type {
  CredentialItem, DubsadoClient, GrantRow, ZohoAccount, ZohoContact, ZohoLead,
} from './sources.ts';
import { normalizePhone } from './sources.ts';

export interface PlannedContact {
  key: string; // plan-internal id
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  secondaryPhone: string | null;
  addressLine1: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  language: 'en';
  sotoStatus: 'active' | 'inactive' | 'lead';
  clientSince: string | null;
  notes: string | null;
  source: 'dubsado' | 'zoho';
  sourceRef: string;
  sources: Array<{ source: 'dubsado' | 'zoho'; sourceRef: string; raw: Record<string, string> }>;
  missingFields: string[];
}

export interface PlannedBusiness {
  key: string;
  name: string;
  ein: string | null;
  entityType: string | null;
  industry: string | null;
  irsActivityCode: string | null;
  state: string;
  zip: string | null;
  notes: string | null;
  sourceRef: string;
  ownerKeys: string[]; // PlannedContact keys
  raw: Record<string, string>;
  missingFields: string[];
}

export interface PlannedGrant {
  funder: string;
  program: string | null;
  amountCents: number | null;
  submissionType: 'loi' | 'application' | 'proposal' | 'rfp' | null;
  status: 'prospect' | 'loi' | 'in_progress' | 'submitted' | 'pending' | 'approved' | 'denied' | 'ineligible';
  internalDeadline: string | null;
  hardDeadline: string | null;
  materialsLink: string | null;
  notes: string | null;
  raw: Record<string, string>;
}

export interface SkippedRecord {
  source: 'dubsado' | 'zoho' | 'zoho_lead';
  sourceRef: string;
  reason: string;
  raw: Record<string, string>;
}

export interface ImportPlan {
  contacts: PlannedContact[];
  businesses: PlannedBusiness[];
  grants: PlannedGrant[];
  credentials: CredentialItem[];
  skipped: SkippedRecord[];
  reviewFlags: string[]; // human-readable "look at this" notes for the report
  stats: Record<string, number>;
}

export interface PlanOptions {
  today: string;               // ISO date — clock-injectable like every job
  dubsadoWindowMonths: number; // default 36
  zohoInactiveMonths: number;  // default 36
}

function monthsBetween(fromIso: string, toIso: string): number {
  return (Date.parse(toIso) - Date.parse(fromIso)) / (30.44 * 86_400_000);
}

export function mapGrantStatus(raw: string | null): PlannedGrant['status'] {
  const t = (raw ?? '').toLowerCase();
  if (t.includes('approved') || t.includes('awarded') || t.includes('received') || t.includes('funded')) return 'approved';
  if (t.includes('denied') || t.includes('declined') || t.includes('rejected') || t.includes('not selected')) return 'denied';
  if (t.includes('ineligible') || t.includes('not eligible')) return 'ineligible';
  if (t.includes('submitted') || t.includes('applied')) return 'submitted';
  if (t.includes('pending') || t.includes('review') || t.includes('waiting')) return 'pending';
  if (t.includes('progress') || t.includes('started') || t.includes('working') || t.includes('drafting')) return 'in_progress';
  if (t.includes('loi')) return 'loi';
  return 'prospect';
}

export function mapSubmissionType(raw: string | null): PlannedGrant['submissionType'] {
  const t = (raw ?? '').toLowerCase();
  if (t.includes('loi') || t.includes('letter of intent')) return 'loi';
  if (t.includes('proposal')) return 'proposal';
  if (t.includes('rfp')) return 'rfp';
  if (t.includes('app')) return 'application';
  return null;
}

function joinNotes(...parts: Array<string | null>): string | null {
  const real = parts.filter((p): p is string => p !== null && p.trim() !== '');
  return real.length === 0 ? null : real.join(' · ');
}

export function buildPlan(
  input: {
    dubsado: DubsadoClient[];
    zoho: { contacts: ZohoContact[]; accounts: ZohoAccount[]; leads: ZohoLead[]; links: Array<{ contactRef: string; accountRef: string }> };
    grants: GrantRow[];
    credentials: CredentialItem[];
  },
  opts: PlanOptions
): ImportPlan {
  const { today } = opts;
  const contacts: PlannedContact[] = [];
  const skipped: SkippedRecord[] = [];
  const reviewFlags: string[] = [];
  const byEmail = new Map<string, PlannedContact>();
  const byPhone = new Map<string, PlannedContact>();
  let keySeq = 0;

  const indexContact = (c: PlannedContact) => {
    if (c.email) byEmail.set(c.email, c);
    for (const p of [normalizePhone(c.phone), normalizePhone(c.secondaryPhone)]) {
      if (p && !byPhone.has(p)) byPhone.set(p, c);
    }
  };
  const findMatch = (email: string | null, ...phones: Array<string | null>): PlannedContact | null => {
    if (email && byEmail.has(email)) return byEmail.get(email)!;
    for (const raw of phones) {
      const p = normalizePhone(raw);
      if (p && byPhone.has(p)) return byPhone.get(p)!;
    }
    return null;
  };

  // ── Dubsado first: the client system of record ────────────────────────────
  let dubsadoActive = 0;
  let dubsadoStale = 0;
  for (const d of input.dubsado) {
    const age = d.lastActivity ? monthsBetween(d.lastActivity, today) : Infinity;
    if (age > opts.dubsadoWindowMonths) {
      skipped.push({
        source: 'dubsado',
        sourceRef: d.sourceRef,
        reason: d.lastActivity
          ? `inactive ${Math.round(age)}mo (window ${opts.dubsadoWindowMonths}mo)`
          : 'no activity date on record',
        raw: d.raw,
      });
      continue;
    }
    const sotoStatus = age <= 24 ? 'active' : 'inactive';
    const c: PlannedContact = {
      key: `c${keySeq++}`,
      firstName: d.firstName,
      lastName: d.lastName,
      email: d.email,
      phone: d.phone,
      secondaryPhone: null,
      addressLine1: d.addressLine1,
      city: d.city,
      state: d.state,
      zip: d.zip,
      language: 'en',
      sotoStatus,
      clientSince: d.startDate,
      notes: joinNotes(
        d.company ? `Dubsado company: ${d.company}` : null,
        d.title ? `Dubsado title: ${d.title}` : null,
        `Dubsado projects: ${d.projectCount}, invoices: ${d.invoiceCount}`
      ),
      source: 'dubsado',
      sourceRef: d.sourceRef,
      sources: [{ source: 'dubsado', sourceRef: d.sourceRef, raw: d.raw }],
      missingFields: [],
    };
    const dup = findMatch(c.email, c.phone);
    if (dup) {
      skipped.push({ source: 'dubsado', sourceRef: d.sourceRef, reason: `duplicate of ${dup.firstName} ${dup.lastName} within Dubsado`, raw: d.raw });
      continue;
    }
    if (sotoStatus === 'active') dubsadoActive++;
    else dubsadoStale++;
    contacts.push(c);
    indexContact(c);
  }

  // ── Zoho contacts: enrich matches, add the rest ───────────────────────────
  let zohoMerged = 0;
  let zohoNew = 0;
  const zohoContactToPlan = new Map<string, PlannedContact>(); // Record Id → planned
  for (const z of input.zoho.contacts) {
    const age = z.lastActivity ? monthsBetween(z.lastActivity, today) : Infinity;
    const match = findMatch(z.email ?? z.secondaryEmail, z.phone, z.secondaryPhone);
    if (match) {
      // Merge: fill gaps only — never overwrite the client system of record.
      zohoMerged++;
      match.phone ??= z.phone;
      match.secondaryPhone ??= z.secondaryPhone;
      match.email ??= z.email ?? z.secondaryEmail;
      match.addressLine1 ??= z.addressLine1;
      match.city ??= z.city;
      match.state ??= z.state;
      match.zip ??= z.zip;
      match.notes = joinNotes(match.notes, z.description ? `Zoho: ${z.description}` : null);
      match.sources.push({ source: 'zoho', sourceRef: z.sourceRef, raw: z.raw });
      zohoContactToPlan.set(z.sourceRef, match);
      indexContact(match);
      continue;
    }
    if (age > opts.zohoInactiveMonths && !z.tag) {
      skipped.push({
        source: 'zoho',
        sourceRef: z.sourceRef,
        reason: z.lastActivity
          ? `inactive ${Math.round(age)}mo, untagged (window ${opts.zohoInactiveMonths}mo)`
          : 'no activity date, untagged',
        raw: z.raw,
      });
      continue;
    }
    zohoNew++;
    const c: PlannedContact = {
      key: `c${keySeq++}`,
      firstName: z.firstName,
      lastName: z.lastName,
      email: z.email ?? z.secondaryEmail,
      phone: z.phone,
      secondaryPhone: z.secondaryPhone,
      addressLine1: z.addressLine1,
      city: z.city,
      state: z.state,
      zip: z.zip,
      language: 'en',
      sotoStatus: 'lead',
      clientSince: null,
      notes: joinNotes(z.description ? `Zoho: ${z.description}` : null, z.tag ? `Zoho tag: ${z.tag}` : null),
      source: 'zoho',
      sourceRef: z.sourceRef,
      sources: [{ source: 'zoho', sourceRef: z.sourceRef, raw: z.raw }],
      missingFields: [],
    };
    contacts.push(c);
    indexContact(c);
    zohoContactToPlan.set(z.sourceRef, c);
  }

  // ── Zoho unconverted leads ────────────────────────────────────────────────
  let leadsImported = 0;
  for (const l of input.zoho.leads) {
    if (l.isConverted) {
      skipped.push({ source: 'zoho_lead', sourceRef: l.sourceRef, reason: 'already converted — exists as a Zoho contact', raw: l.raw });
      continue;
    }
    const age = l.lastActivity ? monthsBetween(l.lastActivity, today) : Infinity;
    if (age > opts.zohoInactiveMonths) {
      skipped.push({ source: 'zoho_lead', sourceRef: l.sourceRef, reason: `lead inactive ${Math.round(age)}mo`, raw: l.raw });
      continue;
    }
    if (findMatch(l.email, l.phone)) {
      skipped.push({ source: 'zoho_lead', sourceRef: l.sourceRef, reason: 'duplicate of an imported contact', raw: l.raw });
      continue;
    }
    leadsImported++;
    const c: PlannedContact = {
      key: `c${keySeq++}`,
      firstName: l.firstName,
      lastName: l.lastName,
      email: l.email,
      phone: l.phone,
      secondaryPhone: null,
      addressLine1: null,
      city: null,
      state: null,
      zip: null,
      language: 'en',
      sotoStatus: 'lead',
      clientSince: null,
      notes: l.company ? `Zoho lead — company: ${l.company}` : 'Zoho lead',
      source: 'zoho',
      sourceRef: l.sourceRef,
      sources: [{ source: 'zoho', sourceRef: l.sourceRef, raw: l.raw }],
      missingFields: [],
    };
    contacts.push(c);
    indexContact(c);
  }

  // Same-name pairs without shared contact info: review, never auto-merge.
  const byName = new Map<string, number>();
  for (const c of contacts) {
    const k = `${c.firstName} ${c.lastName}`.toLowerCase();
    byName.set(k, (byName.get(k) ?? 0) + 1);
  }
  const nameDupes = [...byName.entries()].filter(([, n]) => n > 1);
  if (nameDupes.length > 0) {
    reviewFlags.push(
      `${nameDupes.length} name(s) appear on multiple planned contacts without a shared email/phone — imported separately; review in CRM: ${nameDupes.map(([n]) => n).join('; ')}`
    );
  }

  // ── Businesses (Zoho accounts) ────────────────────────────────────────────
  const ownersByAccount = new Map<string, string[]>();
  for (const link of input.zoho.links) {
    const planned = zohoContactToPlan.get(link.contactRef);
    if (!planned) continue;
    const list = ownersByAccount.get(link.accountRef) ?? [];
    if (!list.includes(planned.key)) list.push(planned.key);
    ownersByAccount.set(link.accountRef, list);
  }

  const businesses: PlannedBusiness[] = [];
  let accountsSkippedNoOwner = 0;
  let accountsSkippedPersonal = 0;
  const contactByKey = new Map(contacts.map((c) => [c.key, c]));
  for (const a of input.zoho.accounts) {
    const ownerKeys = ownersByAccount.get(a.sourceRef) ?? [];
    if (ownerKeys.length === 0) {
      accountsSkippedNoOwner++;
      continue;
    }
    const hasBusinessData = Boolean(a.ein || a.entityRaw || a.dba || a.industry || a.irsBusinessCode || a.fileNumber);
    const ownerNames = ownerKeys
      .map((k) => contactByKey.get(k))
      .filter((c): c is PlannedContact => c !== undefined)
      .map((c) => `${c.firstName} ${c.lastName}`.toLowerCase());
    const looksLikePersonalShell = !hasBusinessData && ownerNames.includes(a.name.toLowerCase());
    if (looksLikePersonalShell) {
      accountsSkippedPersonal++;
      continue;
    }
    const missing: string[] = [];
    if (!a.ein) missing.push('business:ein');
    if (!a.entityType) missing.push('business:entity_type');
    if (!a.industry) missing.push('business:industry');
    businesses.push({
      key: `b${businesses.length}`,
      name: a.name,
      ein: a.ein,
      entityType: a.entityType,
      industry: a.industry,
      irsActivityCode: a.irsBusinessCode,
      state: a.state ?? 'IL',
      zip: a.zip,
      notes: joinNotes(
        a.dba ? `DBA: ${a.dba}` : null,
        a.entityRaw && !a.entityType ? `Entity (unmapped): ${a.entityRaw}` : null,
        a.website ? `Website: ${a.website}` : null,
        a.formationDate ? `Formed: ${a.formationDate}` : null,
        a.fileNumber ? `IL SOS file #: ${a.fileNumber}` : null,
        a.registeredAgent ? `Registered agent: ${a.registeredAgent}` : null
      ),
      sourceRef: a.sourceRef,
      ownerKeys,
      raw: a.raw,
      missingFields: missing,
    });
  }

  const unmappedEntities = [...new Set(
    input.zoho.accounts.filter((a) => a.entityRaw && !a.entityType).map((a) => a.entityRaw as string)
  )];
  if (unmappedEntities.length > 0) {
    reviewFlags.push(`Unmapped Zoho "Entity" values (kept in business notes): ${unmappedEntities.join(', ')}`);
  }

  // ── Contact enrichment gaps ───────────────────────────────────────────────
  for (const c of contacts) {
    if (!c.email) c.missingFields.push('email');
    if (!c.phone) c.missingFields.push('phone');
  }
  for (const b of businesses) {
    // Business gaps land on the primary owner's queue entry.
    const owner = contactByKey.get(b.ownerKeys[0]!);
    if (owner) owner.missingFields.push(...b.missingFields);
  }

  // ── Grants ────────────────────────────────────────────────────────────────
  const grants: PlannedGrant[] = input.grants.map((g) => ({
    funder: g.funder,
    program: g.program,
    amountCents: g.amountCents,
    submissionType: mapSubmissionType(g.submissionTypeRaw),
    status: mapGrantStatus(g.statusRaw),
    internalDeadline: g.internalDeadline,
    hardDeadline: g.hardDeadline,
    materialsLink: g.materialsLink,
    notes: joinNotes(
      g.sheetYear ? `Tracker year: ${g.sheetYear}` : null,
      g.timeframe ? `Timeframe: ${g.timeframe}` : null,
      g.leadRaw ? `Lead: ${g.leadRaw}` : null,
      g.statusRaw ? `Status as tracked: ${g.statusRaw}` : null,
      g.amountRaw && g.amountCents === null ? `Amount as tracked: ${g.amountRaw}` : null,
      g.dateReceived ? `Received: ${g.dateReceived}` : null,
      g.notes
    ),
    raw: g.raw,
  }));

  const amountUnparsed = input.grants.filter((g) => g.amountRaw && g.amountCents === null).length;
  if (amountUnparsed > 0) {
    reviewFlags.push(`${amountUnparsed} grant amount(s) were not clean dollar figures — kept verbatim in notes, amount_cents left empty.`);
  }

  return {
    contacts,
    businesses,
    grants,
    credentials: input.credentials,
    skipped,
    reviewFlags,
    stats: {
      dubsado_rows: input.dubsado.length,
      dubsado_active: dubsadoActive,
      dubsado_inactive_in_window: dubsadoStale,
      zoho_contact_rows: input.zoho.contacts.length,
      zoho_merged_into_dubsado: zohoMerged,
      zoho_new_contacts: zohoNew,
      zoho_lead_rows: input.zoho.leads.length,
      zoho_leads_imported: leadsImported,
      contacts_planned: contacts.length,
      businesses_planned: businesses.length,
      accounts_skipped_no_imported_owner: accountsSkippedNoOwner,
      accounts_skipped_personal_shell: accountsSkippedPersonal,
      grants_planned: grants.length,
      credentials_to_vaultwarden: input.credentials.length,
      skipped_total: skipped.length,
    },
  };
}
