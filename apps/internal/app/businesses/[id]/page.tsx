'use client';

/*
 * THE BUSINESS PAGE (Brian, 2026-09-26, R40; proposal docs/proposals/2026-09-20-business-page.md).
 *
 * Until now a business lived only as a row in a person's Businesses card, and the Trello service
 * facts (books current through, QBO payer, annual-report anniversary, access facts) attach to the
 * business, not the person. This is the business's own page: entity details, owners, engagements,
 * returns, service facts, invoices, documents — in that order — reached from the client page's
 * Businesses card and from a "Business — owner" row in the clients list. No navigation item: a
 * business is found through a person or a search, never browsed.
 *
 * ONE READ, PER-CARD PERMISSIONS ON THE SERVER. GET /businesses/:id sends each card as rows or as
 * { refused: true, permission }; a refused card prints "Not available to your role" (R64) and never
 * an empty state it cannot vouch for. Nothing here decides what a role may read. The EIN arrives as
 * the last four unless the session holds pii.read, in which case the whole number comes too.
 *
 * BEHIND OPS_BUSINESS_PAGE (R57): the switch is read from GET /auth/me like the others; off, this
 * page prints one sentence and the links that lead here are not rendered. Null until the session
 * answers, so the page never guesses.
 *
 * Deliver Return and New quote keep their client rows: a return is delivered to a person's portal
 * and a quote is for a person, so those searches still open the client.
 */

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { api, formatMoney, isAuthed } from '../../../lib/api';
import { dayOf, formatDate } from '../../../lib/dates';
import { EditBusinessModal } from '../../../components/edit-business';
import { engagementStatusSentence, invoiceStatusLabel, taxStageLabel } from '../../../lib/labels';
import { badgeToneFor, invoiceStatusLine } from '../../../lib/invoice-display';
import { amountLabel, showExtendedBadge } from '../../../lib/return-stepper';

interface Entity {
  id: string; name: string; status: string | null; entity_type: string | null;
  ein_on_file: boolean; ein_last4: string | null; ein?: string | null;
  state: string | null; fiscal_year_end_month: number | null; industry: string | null; naics_code: string | null;
  formation_date: string | null; formation_date_source: string | null;
  il_sos_status: string | null; il_sos_checked_at: string | null;
  is_test: boolean; test_note: string | null; unverified_import_source: string | null;
  created_at: string;
}
interface Member { contact_id: string; first_name: string; last_name: string; member_role: string | null; is_primary: boolean; contact_archived: boolean }
interface Refused { refused: true; permission: string }
interface Rows<T> { rows: T[] }
interface EngagementRow {
  id: string; contact_id: string; service_line: string; status: string; title: string | null; period_key: string | null;
  lead_staff_name: string | null; started_on: string | null; ended_on: string | null; close_reason: string | null;
  work_paused_at: string | null; created_at: string;
  prep_cadence: string | null; filing_frequency: string | null; payroll_provider: string | null;
  open_balance_cents: number; scopeName: string | null; scopeSummary: { count: number; totalCents: number };
}
interface ReturnRow {
  id: string; tax_year: number; return_type: string; stage: string;
  preparer_name: string | null; preparer_of_record: string | null;
  extension_filed: boolean; filed_date: string | null;
  federal_accepted_on: string | null; state_accepted_on: string | null; state_accepted_code: string | null;
  estimated_fee_max_cents: number | null; final_fee_cents: number | null;
  f8879_document_id: string | null; f8879_signed_on: string | null;
  contact_id: string; first_name: string; last_name: string;
}
interface ServiceFacts {
  books: { currentThrough: string | null; asOf: string | null };
  qbo: { paidBy: string; asOf: string | null };
  annualReport: { state: string; anniversary_mmdd: string | null; anniversary_kind: string | null; annual_report_due_date: string | null; status: string; last_filed_date: string | null } | null;
  accessFacts: Array<{ fact: string; as_of: string; source: string }>;
  salesTaxFrequencies: string[];
  payrollProviders: string[];
  imports: Array<{ source: string; trello_source_id: string; fact_type: string; as_of: string; applied_at: string; applied_by: string; rows_written: number }>;
}
interface InvoiceRow {
  id: string; invoice_number: string; status: string; total_cents: number; amount_paid_cents: number;
  amount_refunded_cents: number | null; sent_at: string | null; paid_at: string | null;
  void_reason: string | null; voided_at: string | null; voided_by: string | null; refunded_at: string | null;
  contact_id: string;
}
interface DocumentRow { id: string; category: string; original_filename: string; status: string; scan_status: string | null; created_at: string; contact_id: string }
interface Aggregate {
  business: Entity;
  members: Member[];
  engagements: Refused | Rows<EngagementRow>;
  returns: Refused | Rows<ReturnRow>;
  serviceFacts: ServiceFacts;
  invoices: Refused | Rows<InvoiceRow>;
  documents: Refused | Rows<DocumentRow>;
}
const isRefused = <T,>(x: Refused | Rows<T>): x is Refused => (x as Refused).refused === true;

const OFF_SENTENCE = 'This page is not switched on.';
const words = (v: string | null | undefined): string => (v ?? '').replaceAll('_', ' ');

/** R64: the sentence a refused card prints, in place of rows it never had. */
function RoleUnavailable({ card }: { card: string }) {
  return <p className="muted small" data-testid="role-unavailable" data-card={card}>Not available to your role</p>;
}

export default function BusinessPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const [data, setData] = useState<Aggregate | null>(null);
  const [error, setError] = useState('');
  const [businessPage, setBusinessPage] = useState<'on' | 'off' | null>(null);
  /** The Edit door renders for contacts.write or businesses.write (the route's own gate), for nobody else. */
  const [canEdit, setCanEdit] = useState(false);
  const [editing, setEditing] = useState(false);
  const [actionMsg, setActionMsg] = useState('');

  const load = useCallback(async () => {
    try {
      setData(await api<Aggregate>(`/businesses/${params.id}`));
      setError('');
    } catch (err) {
      const e = err as { status?: number; code?: string; message?: string };
      // The route refuses with the page's own sentence while the switch is off; the page prints it once, below.
      if (e.code === 'business_page_off') { setBusinessPage('off'); return; }
      setError(e.status === 404 ? 'Business not found. It may have been archived or merged; its history stays on the owner’s record.' : e.message ?? 'Could not load the business.');
    }
  }, [params.id]);

  useEffect(() => {
    if (!isAuthed()) { router.replace('/login'); return; }
    let alive = true;
    api<{ permissions: string[]; switches?: { businessPage?: 'on' | 'off' } }>('/auth/me')
      .then((m) => {
        if (!alive) return;
        setCanEdit(['*', 'contacts.write', 'businesses.write'].some((p) => m.permissions.includes(p)));
        // Anything but the server saying "on" is off: a missing field is a closed door, never an open one.
        const state = m.switches?.businessPage === 'on' ? 'on' : 'off';
        setBusinessPage(state);
        if (state === 'on') void load();
      })
      .catch(() => { if (alive) { setCanEdit(false); setBusinessPage(null); } });
    return () => { alive = false; };
  }, [router, load]);

  if (businessPage === null) return <p className="muted">Loading…</p>;
  if (businessPage === 'off') return <p className="muted" data-testid="business-page-off">{OFF_SENTENCE}</p>;
  if (error) return <div className="alert error">{error}</div>;
  if (!data) return <p className="muted">Loading…</p>;

  const b = data.business;
  const facts = data.serviceFacts;
  const primaryOwner = data.members.find((m) => m.is_primary) ?? data.members[0] ?? null;
  const einText = b.ein ? `EIN ${b.ein}` : b.ein_on_file ? `EIN ending ${b.ein_last4 ?? '????'}` : 'no EIN on file';

  return (
    <>
      <h1>{b.name}</h1>
      {actionMsg ? <p className="alert ok" role="status" aria-live="polite">{actionMsg}</p> : null}
      <p className="muted small" data-testid="business-owner-line">
        {data.members.length === 0 ? 'No owner on file.' : (
          <>
            {data.members.length === 1 ? 'Owner: ' : 'Owners: '}
            {data.members.map((m, i) => (
              <span key={m.contact_id}>
                {i > 0 ? ', ' : ''}
                <Link href={`/clients/${m.contact_id}`}>{m.first_name} {m.last_name}</Link>
              </span>
            ))}
          </>
        )}
      </p>

      <div className="cards">
        {/* ── 1. Entity details ─────────────────────────────────────────────────────────────── */}
        <section className="card" data-testid="card-entity">
          <h2>Entity details</h2>
          <p>
            {b.is_test ? <span className="badge warn test-client-badge" title={b.test_note ?? undefined}>TEST</span> : null}
            {b.status === 'dissolved' ? <span className="badge warn">dissolved</span> : <span className="badge ok">{words(b.status) || 'active'}</span>}
            {b.unverified_import_source ? (
              <span className="badge warn" title="Named after the client by the import, with no EIN and no entity type: an import artifact or a sole proprietorship. Verify before relying on it.">
                unverified import ({b.unverified_import_source})
              </span>
            ) : null}
            {b.il_sos_status && b.il_sos_status !== 'good_standing' && b.il_sos_status !== 'unknown' ? <span className="badge warn">IL SOS: {words(b.il_sos_status)}</span> : null}
          </p>
          <ul className="list small">
            <li><span className="grow">Entity type</span><span>{b.entity_type ? words(b.entity_type) : 'unknown'}</span></li>
            <li><span className="grow">EIN</span><span data-testid="entity-ein">{einText}</span></li>
            <li><span className="grow">State</span><span>{b.state ?? '—'}</span></li>
            <li><span className="grow">Fiscal year end</span><span>{b.fiscal_year_end_month ? `month ${b.fiscal_year_end_month}` : '—'}</span></li>
            <li><span className="grow">Industry</span><span>{b.industry ? words(b.industry) : '—'}{b.naics_code ? ` · NAICS ${b.naics_code}` : ''}</span></li>
            <li><span className="grow">Formed</span><span>{b.formation_date ? `${formatDate(b.formation_date)}${b.formation_date_source ? ` (${words(b.formation_date_source)})` : ''}` : 'not recorded'}</span></li>
            <li><span className="grow">IL SOS</span><span>{words(b.il_sos_status) || 'unknown'}{b.il_sos_checked_at ? ` · checked ${dayOf(b.il_sos_checked_at)}` : ''}</span></li>
            <li><span className="grow">On record since</span><span>{dayOf(b.created_at)}</span></li>
          </ul>
          {b.is_test && b.test_note ? <p className="muted small">Test note: {b.test_note}</p> : null}
          {canEdit ? (
            <p>
              <button type="button" className="btn ghost small" data-testid={`edit-business-${b.id}`} onClick={() => setEditing(true)}>Edit business</button>
            </p>
          ) : null}
          {editing ? (
            <EditBusinessModal
              business={{ id: b.id, name: b.name, entity_type: b.entity_type, state: b.state, ein: b.ein ?? null, formation_date: b.formation_date, industry: b.industry, ein_withheld_last4: b.ein ? null : b.ein_last4 }}
              onClose={() => setEditing(false)}
              onSaved={async () => { setEditing(false); setActionMsg('Business saved.'); await load(); }}
            />
          ) : null}
        </section>

        {/* ── 2. Owners ─────────────────────────────────────────────────────────────────────── */}
        <section className="card" data-testid="card-owners">
          <h2>Owners ({data.members.length})</h2>
          {data.members.length === 0 ? (
            <p className="muted small">No person is a member of this business.</p>
          ) : (
            data.members.map((m) => (
              <div className="lead-card" key={m.contact_id}>
                <strong><Link href={`/clients/${m.contact_id}`} data-testid={`owner-link-${m.contact_id}`}>{m.first_name} {m.last_name}</Link></strong>
                {m.is_primary ? <span className="badge" title="This business is this person's primary business (one per person)">primary for this person</span> : null}
                {m.contact_archived ? <span className="badge warn">archived contact</span> : null}
                <br />
                <span className="muted small">{m.member_role ? `role: ${m.member_role}` : 'role not recorded'}</span>
              </div>
            ))
          )}
          <p className="muted small">The role is the text intake recorded; no ownership percentage is on file.</p>
        </section>

        {/* ── 3. Engagements ────────────────────────────────────────────────────────────────── */}
        <section className="card span" data-testid="card-engagements">
          <h2>Engagements{isRefused(data.engagements) ? '' : ` (${data.engagements.rows.length})`}</h2>
          {isRefused(data.engagements) ? (
            <RoleUnavailable card="engagements" />
          ) : data.engagements.rows.length === 0 ? (
            <p className="muted small">No engagement names this business. An engagement made by hand may carry no business; it stays on the owner&apos;s record.</p>
          ) : (
            data.engagements.rows.map((e) => (
              <div className="quote-line" key={e.id}>
                <span className="name">
                  {e.scopeName ?? e.title ?? words(e.service_line)}{' '}
                  <span className="badge" data-testid="engagement-status">{engagementStatusSentence(e.status, { pausedDay: e.work_paused_at ? dayOf(e.work_paused_at) : null, endedDay: e.ended_on ? formatDate(e.ended_on) : null })}</span>
                  {e.open_balance_cents > 0 ? <span className="badge warn">Open balance {formatMoney(e.open_balance_cents)}</span> : null}
                  {e.service_line !== (e.scopeName ?? e.title ?? e.service_line) ? <span className="badge">{words(e.service_line)}</span> : null}
                  {e.service_line === 'tax' && e.period_key ? <span className="badge">{/^\d{4}$/.test(e.period_key) ? `${e.period_key} return` : e.period_key}</span> : null}
                  {e.prep_cadence ? <span className="badge">close {words(e.prep_cadence)}</span> : null}
                  {e.filing_frequency ? <span className="badge">files {words(e.filing_frequency)}</span> : null}
                  {e.payroll_provider ? <span className="badge">payroll: {e.payroll_provider}</span> : null}
                </span>
                <span className="muted small" style={{ flex: '1 1 100%' }}>
                  {e.lead_staff_name ? `lead: ${e.lead_staff_name} · ` : ''}
                  started {e.started_on ? formatDate(e.started_on) : dayOf(e.created_at)}
                  {e.ended_on ? ` · ended ${formatDate(e.ended_on)}` : ''}
                  {e.close_reason ? ` · ${e.close_reason}` : ''}
                  {' · '}<Link href={`/clients/${e.contact_id}`}>client page</Link>
                </span>
                <span className="amt">{e.scopeSummary.count > 0 ? formatMoney(e.scopeSummary.totalCents) : '—'}</span>
              </div>
            ))
          )}
        </section>

        {/* ── 4. Returns ────────────────────────────────────────────────────────────────────── */}
        <section className="card span" data-testid="card-returns">
          <h2>Returns{isRefused(data.returns) ? '' : ` (${data.returns.rows.length})`}</h2>
          {isRefused(data.returns) ? (
            <RoleUnavailable card="returns" />
          ) : data.returns.rows.length === 0 ? (
            <p className="muted small">No tax return names this business. Returns are worked from the owner&apos;s client page.</p>
          ) : (
            data.returns.rows.map((t) => (
              <div className="quote-line" key={t.id}>
                <span className="name">
                  {t.tax_year} {t.return_type.toUpperCase()}{' '}
                  <span className="badge">{taxStageLabel(t.stage)}</span>
                  {showExtendedBadge(t) ? <span className="badge warn">extended</span> : null}
                </span>
                <span className="muted small" style={{ flex: '1 1 100%' }}>
                  {t.filed_date ? `filed ${formatDate(t.filed_date)} · preparer of record: ${t.preparer_of_record ?? 'not recorded'}` : `not filed · preparer: ${t.preparer_name ?? 'unassigned'}`}
                  {!t.filed_date ? (t.f8879_document_id ? ` · 8879 on file, signed ${formatDate(t.f8879_signed_on ?? '')}` : ' · 8879 not on file') : ''}
                  {t.federal_accepted_on ? ` · IRS accepted ${formatDate(t.federal_accepted_on)}` : ''}
                  {t.state_accepted_on ? ` · ${t.state_accepted_code ?? 'state'} accepted ${formatDate(t.state_accepted_on)}` : ''}
                  {' · '}<Link href={`/clients/${t.contact_id}`}>{t.first_name} {t.last_name}</Link>
                </span>
                <span className="amt" data-testid={`return-amount-${t.id}`}>{amountLabel(t, formatMoney)}</span>
              </div>
            ))
          )}
        </section>

        {/* ── 5. Service facts (the 0105–0111 tables; the Trello import's facts live here) ──── */}
        <section className="card span" data-testid="card-service-facts">
          <h2>Service facts</h2>
          <ul className="list small">
            <li>
              <span className="grow">Books current through</span>
              <span data-testid="fact-books">{facts.books.currentThrough ? `${formatDate(facts.books.currentThrough)} (as of ${facts.books.asOf ? formatDate(facts.books.asOf) : 'unknown'})` : 'not recorded'}</span>
            </li>
            <li>
              <span className="grow">QBO subscription paid by</span>
              <span data-testid="fact-qbo">{facts.qbo.paidBy === 'unknown' ? 'unknown' : `${facts.qbo.paidBy}${facts.qbo.asOf ? ` (as of ${formatDate(facts.qbo.asOf)})` : ''}`}</span>
            </li>
            <li>
              <span className="grow">Annual report</span>
              <span data-testid="fact-annual-report">
                {facts.annualReport
                  ? [
                    facts.annualReport.annual_report_due_date ? `due ${formatDate(facts.annualReport.annual_report_due_date)}` : 'no due date derived',
                    words(facts.annualReport.status),
                    facts.annualReport.anniversary_mmdd ? `anniversary ${facts.annualReport.anniversary_mmdd} (${facts.annualReport.anniversary_kind ?? 'kind unknown'})` : 'anniversary not recorded',
                    facts.annualReport.last_filed_date ? `last filed ${formatDate(facts.annualReport.last_filed_date)}` : null,
                    facts.annualReport.state,
                  ].filter(Boolean).join(' · ')
                  : 'no compliance record'}
              </span>
            </li>
            <li>
              <span className="grow">Sales tax filing frequency</span>
              <span data-testid="fact-sales-tax">{facts.salesTaxFrequencies.length > 0 ? facts.salesTaxFrequencies.map(words).join(', ') : 'no sales-tax engagement on file'}</span>
            </li>
            <li>
              <span className="grow">Payroll provider</span>
              <span data-testid="fact-payroll">{facts.payrollProviders.length > 0 ? facts.payrollProviders.join(', ') : 'no payroll engagement on file'}</span>
            </li>
            <li>
              <span className="grow">Access facts</span>
              <span data-testid="fact-access">
                {facts.accessFacts.length > 0
                  ? facts.accessFacts.map((f) => `${words(f.fact)} (as of ${formatDate(f.as_of)}, ${f.source})`).join(' · ')
                  : 'none recorded'}
              </span>
            </li>
          </ul>
          <p className="muted small">Access facts are categories, never credentials; credentials live in Vaultwarden.</p>
          {facts.imports.length > 0 ? (
            <details className="small">
              <summary className="muted small">Provenance: {facts.imports.length} imported fact{facts.imports.length === 1 ? '' : 's'}</summary>
              <ul className="list small">
                {facts.imports.map((i) => (
                  <li key={`${i.source}-${i.trello_source_id}-${i.fact_type}`}>
                    <span className="grow">{words(i.fact_type)} from {i.source}, as of {formatDate(i.as_of)}</span>
                    <span className="muted">applied {dayOf(i.applied_at)} by {i.applied_by} · {i.rows_written} row{i.rows_written === 1 ? '' : 's'} written</span>
                  </li>
                ))}
              </ul>
            </details>
          ) : (
            <p className="muted small">No imported fact names this business.</p>
          )}
        </section>

        {/* ── 6. Invoices (attributed through the engagement: invoices carry no business id) ── */}
        <section className="card" data-testid="card-invoices">
          <h2>Invoices{isRefused(data.invoices) ? '' : ` (${data.invoices.rows.length})`}</h2>
          {isRefused(data.invoices) ? (
            <RoleUnavailable card="invoices" />
          ) : data.invoices.rows.length === 0 ? (
            <p className="muted small">No invoice is attributed to this business&apos;s engagements. A standalone invoice on the owner stays on the client page.</p>
          ) : (
            <ul className="list">
              {data.invoices.rows.map((inv) => (
                <li key={inv.id}>
                  <span className="grow">
                    <strong>{inv.invoice_number}</strong> · {formatMoney(inv.total_cents)}
                    {inv.amount_paid_cents > 0 && inv.status !== 'paid' ? <span className="muted"> · {formatMoney(inv.amount_paid_cents)} paid</span> : null}
                    <br />
                    <span className={`badge ${badgeToneFor(inv.status)}`}>{invoiceStatusLabel(inv.status)}</span>
                    <span className="invoice-meta">
                      {inv.status === 'void' || inv.status === 'refunded' || inv.status === 'partially_refunded' ? (
                        <span className="muted small">{invoiceStatusLine(inv, { money: formatMoney, date: (iso) => dayOf(iso) })}</span>
                      ) : null}
                      {inv.sent_at ? <span className="muted small">sent {dayOf(inv.sent_at)}</span> : null}
                      {inv.paid_at ? <span className="muted small">paid {dayOf(inv.paid_at)}</span> : null}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
          {!isRefused(data.invoices) && primaryOwner ? (
            <p className="muted small">Void, refund and reminders are on the <Link href={`/clients/${primaryOwner.contact_id}`}>owner&apos;s client page</Link>.</p>
          ) : null}
        </section>

        {/* ── 7. Documents filed to this business ───────────────────────────────────────────── */}
        <section className="card" data-testid="card-documents">
          <h2>Documents{isRefused(data.documents) ? '' : ` (${data.documents.rows.length})`}</h2>
          {isRefused(data.documents) ? (
            <RoleUnavailable card="documents" />
          ) : data.documents.rows.length === 0 ? (
            <p className="muted small">No document is filed to this business. Uploads made on the owner&apos;s record without naming the business stay there.</p>
          ) : (
            data.documents.rows.slice(0, 12).map((d) => (
              <p key={d.id} className="small" style={{ margin: '3px 0', overflowWrap: 'anywhere' }}>
                <span className="badge">{words(d.category)}</span> {d.original_filename}
                <span className="muted"> · {words(d.status)}{d.scan_status && d.scan_status !== 'clean' ? ` · scan ${words(d.scan_status)}` : ''} · {dayOf(d.created_at)}</span>
              </p>
            ))
          )}
          {!isRefused(data.documents) && data.documents.rows.length > 12 ? (
            <p className="muted small">+{data.documents.rows.length - 12} more filed to this business</p>
          ) : null}
          {!isRefused(data.documents) && primaryOwner ? (
            <p className="muted small"><a href={`/documents?contactId=${primaryOwner.contact_id}`}>Every document for the owner</a></p>
          ) : null}
        </section>
      </div>
    </>
  );
}
