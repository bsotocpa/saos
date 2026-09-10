'use client';

// The client packet (M28, wireframe preparer step 2): "everything in one place —
// the packet is the return's front page. No hunting through email or Dropbox."
//
// This was the single biggest missing surface in ops: there was no client detail
// page anywhere. It leads with the two things that GATE work — §7216 consent and a
// signed engagement letter — because a preparer who starts a return without them
// has done work we cannot deliver.
//
// Reading this record is an audited PII access (the API writes contact.viewed).
// That is deliberate and worth knowing: opening a client's packet leaves a trail.

import { dayOf, formatDate, formatDateTime, formatTime } from '../../../lib/dates';
import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { api, formatMoney, isAuthed } from '../../../lib/api';
import { useAsk } from '../../../components/ask';
import { consent7216Label, engagementStatusLabel, invoiceStatusLabel, letterStatusLabel, quoteStatusLabel } from '../../../lib/labels';
import { describeNotice, type NoticeState } from '../../../lib/notices';
import { badgeToneFor, invoiceStatusLine } from '../../../lib/invoice-display';

interface Contact {
  id: string; first_name: string; last_name: string; email: string | null;
  phone: string | null; language: string; preferred_contact_method: string | null;
  city: string | null; state: string | null;
  soto_status: string; contact_status: string; hilo_status: string; client_since: string | null;
  consent_7216_status: string; engagement_letter_status: string;
  has_portal_access: boolean;
  portal_state: string;
  portal_last_login_at: string | null;
  portal_link_sent_at: string | null;
  health_score: number | null; health_components: Record<string, unknown> | null;
  sms_consent: boolean; source: string; ssn_status: string | null; ssn_last4: string | null;
  notes: string | null;
  is_test: boolean; test_note: string | null;
}
interface Business {
  id: string; name: string; ein: string | null; entity_type: string | null;
  industry: string | null; state: string | null; il_sos_status: string | null;
  member_role: string | null; is_primary: boolean;
}
interface Packet {
  contact: Contact;
  businesses: Business[];
  entityGroups: Array<{ id: string; name: string }>;
  enrichmentGaps: string[];
  magicLinkTtlMinutes: number;
  portalBaseUrl: string;
}
interface TaxEngagement {
  id: string; tax_year: number; return_type: string; stage: string;
  estimated_fee_max_cents: number | null; final_fee_cents: number | null;
  extension_filed: boolean; filed_date: string | null;
}
interface Doc {
  id: string; category: string; original_filename: string; created_at: string;
}
interface Quote {
  created_by?: string | null;
  is_stale?: boolean;
  id: string; status: string; total_cents: number; range_min_cents: number | null;
  range_max_cents: number | null; created_at: string;
}
interface Engagement {
  period_key?: string | null;
  id: string; service_line: string; status: string; title: string | null; created_at: string;
  ended_on: string | null; close_reason: string | null;
  /** #47 — what was agreed, snapshotted at acceptance. Empty for pre-#47 engagements. */
  scopeName: string | null;
  scope: Array<{ itemCode: string; descriptionEn: string; quantity: string; lineCents: number | null; isPassThrough: boolean }>;
  scopeSummary: { count: number; totalCents: number };
}
interface PacketPreview {
  codes: string[];
  titles: Record<string, string>;
  reasons: Record<string, string[]>;
  masterKey: string;
  alreadySigned: boolean;
  alreadyAccepted: string[];
  newSchedules: string[];
}
interface Invoice {
  id: string; invoice_number: string; status: string;
  total_cents: number; amount_paid_cents: number;
  sent_at: string | null; paid_at: string | null;
  amount_refunded_cents?: number | null;
  void_reason?: string | null; voided_by?: string | null; voided_at?: string | null;
  refunded_at?: string | null;
  /** Every client-facing notice about this invoice, in its real state (queued / delivered…). */
  notices: NoticeState[];
}
interface SendLogRow { source: 'outbox' | 'audit'; id: string; what: string; state: string; at: string; detail: string | null }
interface NextSession { id: string; starts_at: string; is_recurring: boolean }
interface PacketRow {
  id: string; status: string; schedule_codes: string[];
  sent_at: string | null; signed_at: string | null; created_at: string;
}
// FINDING #18: sessions with what was said in them, so a recording can be reviewed
// without listening to it again.
interface Session {
  id: string; type: string; source: string; status: string;
  title: string | null; started_at: string | null; created_at: string;
  duration_seconds: number | null;
  summary: string | null;
  decisions: string[] | null;
  action_items: Array<{ owner: string | null; due: string | null; text: string }> | null;
  tax_need: boolean | null;
  model: string | null;
  has_transcript: boolean;
  transcript_language: string | null;
  staff_name: string | null;
  stalled: boolean;
}

/*
 * ONE predicate for both gates, because two of them disagreed (found 2026-08-15).
 *
 * `consent_7216_state` is (not_on_file | requested | signed | declined | revoked) and
 * `engagement_letter_state` uses 'signed' the same way. 'granted' and 'on_file' were
 * never values of either — so the card's own `consentOk` check, which tested for exactly
 * those two, could never be true. A client who really signed got a green "signed" badge
 * inside a warning-bordered card telling staff the gate was unmet.
 *
 * It failed in the safe direction — it never claimed consent that was absent — but a gate
 * that is permanently red is one people learn to scroll past, which is how a real red gets
 * missed. Only 'signed' counts: 'requested' has not happened yet, and 'declined'/'revoked'
 * are the opposite of consent.
 */
const isOnFile = (s: string) => s === 'signed';
const okBadge = (s: string) => (isOnFile(s) ? 'ok' : 'warn');

/*
 * Portal access, in the words a staffer would use (#32). "Invited" is the state worth
 * naming: it means we asked and they have not arrived, which is a person to follow up
 * with rather than a system to fix.
 */
/*
 * Lifecycle, in the words a staffer triaging a list would use (#42). "Onboarding" is the
 * one worth naming precisely: it means they have accepted and are partway through, which
 * is a different call from a lead who has not decided.
 */
const LIFECYCLE_LABEL: Record<string, string> = {
  lead: 'lead',
  onboarding: 'onboarding',
  active: 'active client',
  dormant: 'dormant',
  archived: 'archived',
};
const LIFECYCLE_BADGE: Record<string, string> = {
  active: 'ok',
  onboarding: '',
  lead: '',
  dormant: 'warn',
  archived: 'warn',
};

/*
 * Provenance. "native" was the stored value and it meant nothing to a reader — "Direct"
 * says what it is, and leaves room for the values that are coming.
 */
const SOURCE_LABEL: Record<string, string> = {
  native: 'Direct',
  dubsado: 'Migrated — Dubsado client book',
  zoho: 'Migrated — Zoho CRM',
  migration: 'Migrated from the old book',
  booking: 'Booked a call',
  hilo: 'Hilo referral',
  referral: 'Referral',
};

const PORTAL_LABEL: Record<string, string> = {
  not_invited: 'not invited',
  invited: 'invited',
  active: 'active',
  revoked: 'revoked',
};
const portalBadge = (s: string) => (s === 'active' ? 'ok' : s === 'revoked' ? 'warn' : s === 'invited' ? '' : 'warn');

/** A sign-in link outlives its usefulness in minutes, so say when it already has. */
function linkExpired(sentAt: string, ttlMinutes: number): boolean {
  return Date.now() - new Date(sentAt).getTime() > ttlMinutes * 60_000;
}

export default function ClientPacketPage() {
  const router = useRouter();
  // Item 12 (2026-09-09): every "are you sure / why" is the in-app modal, never the browser's.
  const ask = useAsk();
  const params = useParams<{ id: string }>();
  const [packet, setPacket] = useState<Packet | null>(null);
  const [returns, setReturns] = useState<TaxEngagement[]>([]);
  const [docs, setDocs] = useState<Doc[]>([]);
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [error, setError] = useState('');
  // Engagements (service-line agreements) are a DIFFERENT thing from returns
  // (tax_engagements). The Returns card said "No tax engagements" while the client
  // list said "2 active", and both were right — see the Returns card below.
  const [engagements, setEngagements] = useState<Engagement[]>([]);
  const [packets, setPackets] = useState<PacketRow[]>([]);
  const [preview, setPreview] = useState<PacketPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  // VOID (2026-09-09): the reason is typed where the decision is made, and the outcome is
  // re-read from the server — the same rule as the deposit override, learned the same night.
  // The send log under an invoice, loaded when someone opens it.
  const [sendLogs, setSendLogs] = useState<Record<string, SendLogRow[]>>({});
  const [nextSession, setNextSession] = useState<NextSession | null>(null);
  const [scheduleEngagementId, setScheduleEngagementId] = useState('');
  // Feedback for the actions further down the page — the packet card's message is far
  // enough away to read as "nothing happened" (#40).
  const [actionMsg, setActionMsg] = useState('');
  const [actionErr, setActionErr] = useState('');
  const [editing, setEditing] = useState(false);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [sessions, setSessions] = useState<Session[]>([]);
  // The transcript is a separate, audited fetch — it is never loaded just because
  // someone opened the client record.
  const [openTranscript, setOpenTranscript] = useState<{ id: string; content: string } | null>(null);
  const [transcriptErr, setTranscriptErr] = useState('');

  const load = useCallback(async () => {
    try {
      const p = await api<Packet>(`/contacts/${params.id}`);
      setPacket(p);
      // These are separate reads so a failure in one does not blank the packet.
      await Promise.all([
        api<{ taxEngagements: TaxEngagement[] }>(`/tax-engagements?contactId=${params.id}`)
          .then((r) => setReturns(r.taxEngagements))
          .catch(() => setReturns([])),
        api<{ documents: Doc[] }>(`/documents?contactId=${params.id}`)
          .then((r) => setDocs(r.documents ?? []))
          .catch(() => setDocs([])),
        api<{ quotes: Quote[] }>(`/contacts/${params.id}/quotes`)
          .then((r) => setQuotes(r.quotes ?? []))
          .catch(() => setQuotes([])),
        api<{ engagements: Engagement[] }>(`/engagements?contactId=${params.id}`)
          .then((r) => setEngagements(r.engagements ?? []))
          .catch(() => setEngagements([])),
        api<{ invoices: Invoice[] }>(`/invoices?contactId=${params.id}`)
          .then((r) => setInvoices(r.invoices ?? []))
          .catch(() => setInvoices([])),
        api<{ session: NextSession | null }>(`/contacts/${params.id}/next-session`)
          .then((r) => setNextSession(r.session ?? null))
          .catch(() => setNextSession(null)),
        api<{ packets: PacketRow[] }>(`/contacts/${params.id}/packets`)
          .then((r) => setPackets(r.packets ?? []))
          .catch(() => setPackets([])),
        api<{ meetings: Session[] }>(`/contacts/${params.id}/meetings`)
          .then((r) => setSessions(r.meetings ?? []))
          .catch(() => setSessions([])),
        // The preview refuses when there is nothing to paper (no services, attest
        // without an Addendum, text not final). Its message IS the explanation, so
        // it is shown rather than swallowed.
        api<PacketPreview>(`/contacts/${params.id}/packet/preview`, { method: 'POST', body: {} })
          .then((r) => { setPreview(r); setActionErr(''); })
          .catch((err: unknown) => {
            setPreview(null);
            setActionErr(err instanceof Error ? err.message : 'Could not work out the packet.');
          }),
      ]);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [params.id]);

  /*
   * #44 — close / hold / resume, all three through one helper.
   *
   * Reloads on success AND on failure: the API refuses a second close, a reasonless
   * withdrawal and a click-through of a dunning pause, and in every one of those cases the
   * row on screen is the thing that was out of date. Reporting the refusal without
   * refreshing would leave the button that caused it still sitting there, still wrong.
   */
  const runEngagementAction = useCallback(
    async (
      engagementId: string,
      action: 'close' | 'pause' | 'resume',
      body: Record<string, unknown>,
      okMessage: string
    ) => {
      setBusy(true);
      setActionMsg('');
      setActionErr('');
      try {
        await api(`/engagements/${engagementId}/${action}`, { method: 'POST', body });
        setActionMsg(okMessage);
        return null;
      } catch (err) {
        setActionErr(err instanceof Error ? err.message : 'Could not update the engagement.');
        return (err as { code?: string }).code ?? 'error';
      } finally {
        await load();
        setBusy(false);
      }
    },
    [load]
  );

  useEffect(() => {
    if (!isAuthed()) {
      router.replace('/login');
      return;
    }
    void load();
  }, [router, load]);

  if (error) return <div className="alert error">{error}</div>;
  if (!packet) return <p className="muted">Loading…</p>;

  const c = packet.contact;
  const consentOk = isOnFile(c.consent_7216_status);
  const letterOk = isOnFile(c.engagement_letter_status);

  return (
    <>
      <h1>
        {c.first_name} {c.last_name}
      </h1>
      {/*
        ONE FLASH SLOT (2026-09-09, Brian's ruling). The post-action notice used to be pasted
        into four cards — Brian voided an invoice from his phone and read the result four
        times. It renders here, once, above the first card, and the next action replaces it.
        scripts/check-flash-once.mjs refuses a second render of the same notice on any page.
      */}
      {actionMsg ? <p className="alert ok" role="status" aria-live="polite">{actionMsg}</p> : null}
      {actionErr ? <p className="alert warn" role="alert">{actionErr}</p> : null}
      {/*
        #42. This read "lead · from native" for a client with a signed Master, an answered
        §7216, a paid invoice and a live portal session — two unrelated facts wearing one
        badge, and the first of them wrong.

        Status is LIFECYCLE and it moves. Provenance is where they came from and it never
        moves. They are shown as separate things now and are not composed into one string
        again.
      */}
      <p className="small">
        <span className={`badge ${LIFECYCLE_BADGE[c.contact_status] ?? ''}`}>
          {LIFECYCLE_LABEL[c.contact_status] ?? c.contact_status}
        </span>
        {c.is_test ? (
          <>
            {' '}
            <span
              className="badge warn test-client-badge"
              title={c.test_note ?? 'Test client: workable here, excluded from every number on this page.'}
            >
              TEST
            </span>
          </>
        ) : null}
        {c.client_since ? <span className="muted"> · client since {c.client_since}</span> : null}
        {c.hilo_status !== 'none' ? <span className="muted"> · Hilo: {c.hilo_status}</span> : null}
      </p>
      <p className="muted small">Came to us via {SOURCE_LABEL[c.source] ?? c.source}</p>

      {/* A test client announces itself before anything else on the page, so
          nobody works a rehearsal thinking it is a real engagement. */}
      {c.is_test ? (
        <div className="alert warn">
          <strong>TEST CLIENT — not a real engagement.</strong> Excluded from every report, dashboard,
          health score, funder metric and broadcast audience. Everything else works normally so the
          record can be exercised end to end.
          {c.test_note ? <><br /><span className="small">{c.test_note}</span></> : null}
        </div>
      ) : null}

      {/* The gates come first: a return prepared without these cannot be delivered. */}
      <section className="card" style={{ marginBottom: 12, borderColor: consentOk && letterOk ? undefined : 'var(--warn)' }}>
        <h2>Before you work this</h2>
        <p className="small" style={{ margin: '4px 0' }}>
          <span className={`badge ${okBadge(c.consent_7216_status)}`}>{consent7216Label(c.consent_7216_status)}</span>{' '}
          §7216 consent
        </p>
        <p className="small" style={{ margin: '4px 0' }}>
          <span className={`badge ${okBadge(c.engagement_letter_status)}`}>{letterStatusLabel(c.engagement_letter_status)}</span>{' '}
          Engagement letter
        </p>
        {!consentOk || !letterOk ? (
          <p className="small">
            <strong>What clears it:</strong> send the engagement packet for signature (the Engagement packet card
            below) — the §7216 consent and the engagement letter are both in it. Until they are signed, work can
            be prepared but nothing client-facing sends and no return is delivered; the send paths refuse it rather
            than relying on anyone remembering.
          </p>
        ) : null}
      </section>

      <div className="cards">
        <section className="card">
          <h2>
            Contact{' '}
            {/*
              EDITABLE BASIC INFO (#33). A wrong phone number was a reason to leave the
              client record and go somewhere else to fix it, which is exactly the
              "everything runs from Clients" problem. Deliberately limited to the fields
              that go stale — name, contact details, language. Status, consent and the
              gates are not editable here: those change because something HAPPENED, and a
              text box beside them would invite someone to assert a fact instead.
            */}
            <button className="btn ghost" type="button" onClick={() => setEditing((v) => !v)}>
              {editing ? 'Cancel' : 'Edit'}
            </button>
          </h2>
          {editing ? (
            <div>
              {(
                [
                  ['firstName', 'First name', c.first_name],
                  ['lastName', 'Last name', c.last_name],
                  ['email', 'Email', c.email ?? ''],
                  ['phone', 'Phone', c.phone ?? ''],
                ] as const
              ).map(([field, label, current]) => (
                <label className="field" key={field}>
                  {label}
                  <input
                    value={edits[field] ?? current}
                    onChange={(e) => setEdits((v) => ({ ...v, [field]: e.target.value }))}
                  />
                </label>
              ))}
              <label className="field">
                Language
                <select
                  value={edits.language ?? c.language}
                  onChange={(e) => setEdits((v) => ({ ...v, language: e.target.value }))}
                >
                  <option value="en">English</option>
                  <option value="es">Spanish</option>
                </select>
              </label>
              <label className="field">
                Best way to reach them
                <select
                  value={edits.preferredContactMethod ?? c.preferred_contact_method ?? ''}
                  onChange={(e) => setEdits((v) => ({ ...v, preferredContactMethod: e.target.value }))}
                >
                  <option value="">not set</option>
                  <option value="phone">phone</option>
                  <option value="email">email</option>
                  <option value="text">text</option>
                  <option value="portal">portal</option>
                </select>
              </label>
              <button
                className="btn accent"
                type="button"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  setActionErr('');
                  try {
                    // Only what actually changed — a PATCH that resends every field
                    // would overwrite anything edited elsewhere since this page loaded.
                    const body = Object.fromEntries(
                      Object.entries(edits).filter(([, v]) => v !== undefined && v !== '')
                    );
                    if (Object.keys(body).length === 0) { setEditing(false); return; }
                    await api(`/contacts/${params.id}`, { method: 'PATCH', body });
                    setActionMsg('Saved.');
                    setEdits({});
                    setEditing(false);
                    await load();
                  } catch (e) {
                    setActionErr(e instanceof Error ? e.message : 'Could not save.');
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Save
              </button>
            </div>
          ) : null}
          <p className="small" style={{ overflowWrap: 'anywhere' }}>
            {c.email ?? 'no email'}
            <br />
            {c.phone ?? 'no phone'}
            {c.sms_consent ? <span className="badge ok">SMS ok</span> : <span className="badge">no SMS consent</span>}
            <br />
            <span className="muted">
              {c.language === 'es' ? 'Spanish' : 'English'}
              {c.preferred_contact_method ? ` · prefers ${c.preferred_contact_method}` : ''}
              {c.city ? ` · ${c.city}, ${c.state ?? ''}` : ''}
            </span>
          </p>
          {c.ssn_status ? (
            <p className="muted small">
              SSN: {c.ssn_status}
              {c.ssn_last4 ? ` ···${c.ssn_last4}` : ''} — full value never displayed
            </p>
          ) : null}
          {packet.enrichmentGaps.length > 0 ? (
            <p className="muted small">Missing: {packet.enrichmentGaps.join(', ')}</p>
          ) : null}

          {/*
            PORTAL ACCESS (#32). It was a boolean, surfaced only inside the packet
            section when a draft existed — so the state that actually needs chasing,
            "invited and never arrived", was invisible everywhere.

            The button never disappears once an account exists. A sign-in link expires in
            minutes, so an invite from three days ago is functionally not-invited, and a
            screen that hides Resend because a row exists is hiding the one action that
            helps.
          */}
          <p className="small" style={{ marginTop: 10 }}>
            <span className={`badge ${portalBadge(c.portal_state)}`}>{PORTAL_LABEL[c.portal_state] ?? c.portal_state}</span>{' '}
            Portal access
            {c.portal_state === 'active' ? (
              c.portal_last_login_at ? (
                <span className="muted"> · last signed in {dayOf(c.portal_last_login_at)}</span>
              ) : (
                <span className="muted"> · never signed in — the link was delivered, but nobody has used it yet</span>
              )
            ) : null}
            {c.portal_state === 'invited' && c.portal_link_sent_at ? (
              <span className="muted">
                {' · link sent '}{formatDateTime(c.portal_link_sent_at)}
                {linkExpired(c.portal_link_sent_at, packet.magicLinkTtlMinutes)
                  ? ' — expired, send another'
                  : ' — still valid'}
              </span>
            ) : null}
          </p>
          {c.portal_state === 'revoked' ? (
            /* Deliberately no one-click restore. Access was taken away on purpose, and
               the reason lives outside this screen — re-granting it should be a decision
               someone makes knowingly, not a button next to a red badge. */
            <p className="muted small">
              Access was revoked. Re-granting is deliberate — reactivate the portal account first.
            </p>
          ) : (
            <button
              className="btn ghost"
              type="button"
              disabled={busy}
              onClick={async () => {
                const first = c.portal_state === 'not_invited';
                const ok = await ask({
                  title: first ? 'Grant portal access?' : 'Send another sign-in link?',
                  body: <p>{first ? 'The client is emailed a secure sign-in link and a welcome.' : 'The previous link stops working.'}</p>,
                  choices: [{ key: 'go', label: first ? 'Grant access' : 'Send link', tone: 'primary' }],
                });
                if (!ok) return;
                setBusy(true);
                setActionErr('');
                try {
                  await api('/portal-users', { method: 'POST', body: { contactId: params.id } });
                  setActionMsg(first ? 'Invited — the client was emailed a sign-in link.' : 'A fresh sign-in link is on its way.');
                  await load();
                } catch (e) {
                  setActionErr(e instanceof Error ? e.message : 'Could not send the link.');
                } finally {
                  setBusy(false);
                }
              }}
            >
              {c.portal_state === 'not_invited' ? 'Grant access' : 'Resend sign-in link'}
            </button>
          )}
        </section>

        <section className="card">
          <h2>Businesses</h2>
          {packet.businesses.length === 0 ? (
            <p className="muted small">Individual client — no business on file.</p>
          ) : (
            packet.businesses.map((b) => (
              <div className="lead-card" key={b.id}>
                <strong>{b.name}</strong>
                {b.is_primary ? <span className="badge">primary</span> : null}
                <br />
                <span className="muted small">
                  {b.entity_type ?? 'entity type unknown'}
                  {b.ein ? ` · EIN on file` : ' · no EIN'}
                  {b.state ? ` · ${b.state}` : ''}
                  {b.industry ? ` · ${b.industry}` : ''}
                </span>
                {b.il_sos_status && b.il_sos_status !== 'good_standing' ? (
                  <>
                    <br />
                    <span className="badge warn">IL SOS: {b.il_sos_status.replaceAll('_', ' ')}</span>
                  </>
                ) : null}
              </div>
            ))
          )}
          {packet.entityGroups.length > 0 ? (
            <p className="muted small">
              Entity group: {packet.entityGroups.map((g) => g.name).join(', ')}
            </p>
          ) : null}
        </section>

        <section className="card">
          <h2>Documents ({docs.length})</h2>
          {docs.length === 0 ? (
            <p className="muted small">Nothing uploaded yet.</p>
          ) : (
            docs.slice(0, 12).map((d) => (
              <p key={d.id} className="small" style={{ margin: '3px 0', overflowWrap: 'anywhere' }}>
                <span className="badge">{d.category.replaceAll('_', ' ')}</span> {d.original_filename}
                <span className="muted"> · {dayOf(d.created_at)}</span>
              </p>
            ))
          )}
          {docs.length > 12 ? (
            <p className="muted small">
              <a href={`/documents?contactId=${params.id}`}>+{docs.length - 12} more — every document for this client</a>
            </p>
          ) : null}
        </section>

        <section className="card">
          <h2>Quotes</h2>
          {quotes.length === 0 ? (
            <p className="muted small">No quotes sent.</p>
          ) : (
            quotes.slice(0, 6).map((q) => (
              <p key={q.id} className="small" style={{ margin: '3px 0' }}>
                <span className={`badge ${q.status === 'accepted' ? 'ok' : q.status === 'sent' ? '' : 'warn'}`}>
                  {quoteStatusLabel(q.status)}
                </span>{' '}
                {q.range_min_cents !== null && q.range_max_cents !== null
                  ? `${formatMoney(q.range_min_cents)}–${formatMoney(q.range_max_cents)}`
                  : formatMoney(q.total_cents)}
                <span className="muted"> · {dayOf(q.created_at)}</span>
                {/* Audit item 6 (2026-09-09): a draft says who started it and when; stale after 30 days; withdrawn with a reason, never deleted. */}
                {q.status === 'draft' ? (
                  <>
                    <span className="muted"> · started by {q.created_by ?? 'unknown'}</span>
                    {q.is_stale ? <> <span className="badge warn" title="A draft older than 30 days. Nothing deletes it — withdraw it, or send it.">stale</span></> : null}
                    {' '}
                    <button
                      type="button"
                      className="btn ghost small"
                      disabled={busy}
                      onClick={async () => {
                        const a = await ask({
                          title: 'Withdraw this draft quote?',
                          body: <p className="small">The draft stays on the record as withdrawn, with your reason. Nothing is sent to the client.</p>,
                          reason: { label: 'Why', required: true },
                          choices: [{ key: 'withdraw', label: 'Withdraw draft', tone: 'danger' }],
                        });
                        if (!a) return;
                        setBusy(true);
                        setActionErr('');
                        try {
                          await api(`/quotes/${q.id}/withdraw-draft`, { method: 'POST', body: { reason: a.reason } });
                          setActionMsg('Draft withdrawn.');
                          await load();
                        } catch (err) {
                          setActionErr(err instanceof Error ? err.message : 'Could not withdraw the draft.');
                        } finally {
                          setBusy(false);
                        }
                      }}
                    >
                      Withdraw draft…
                    </button>
                  </>
                ) : null}
              </p>
            ))
          )}
        </section>
      </div>

      {/* ENGAGEMENT PACKET — Master + only the schedules this client's services
          require. This action existed only as an API endpoint until now, so there
          was no way to paper a client from the UI at all. */}
      <section className="card span" style={{ marginTop: 12 }}>
        <h2>Engagement packet</h2>
        {/* Audit item 5 (2026-09-09): the gate card above is the one place that explains a blocked
            state; this card only shows the packet, or the one action that creates it. */}
        {packets.length > 0 ? (
          <>
            {packets.map((p) => (
              <div className="quote-line" key={p.id}>
                <span className="name">
                  Packet <span className="badge">{p.schedule_codes.join(' · ') || 'no schedules'}</span>{' '}
                  <span className={`badge ${p.status === 'signed' ? 'ok' : p.status === 'sent' ? 'warn' : ''}`}>
                    {p.status}
                  </span>
                </span>
                <span className="muted small" style={{ flex: '1 1 100%' }}>
                  created {dayOf(p.created_at)}
                  {p.sent_at ? ` · sent ${dayOf(p.sent_at)}` : ''}
                  {p.signed_at ? ` · signed ${dayOf(p.signed_at)}` : ''}
                </span>
                {/* THE PROMISED ACTIONS, made clickable. The banner told Brian to
                    "review the document, then send it for signature" and the row had
                    neither button — the same failure as the pipeline card. */}
                <span style={{ flex: '1 1 100%', marginTop: 6 }}>
                  <a
                    className="btn ghost"
                    href={`/api/packets/${p.id}/document.html`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Review document
                  </a>{' '}
                  {p.status === 'draft' && packet?.contact.has_portal_access === false ? (
                    /* Portal access is a PRECONDITION now that packets are signed in
                       the portal. Offering Send here without it would fail with a
                       message the screen could not act on, so the fix is offered at
                       the point of need instead. */
                    <button
                      className="btn accent"
                      type="button"
                      disabled={busy}
                      onClick={async () => {
                        if (!(await ask({ title: 'Grant portal access?', body: <p>The client is emailed a secure sign-in link.</p>, choices: [{ key: 'go', label: 'Grant access', tone: 'primary' }] }))) return;
                        setBusy(true);
                        setActionErr('');
                        try {
                          await api('/portal-users', { method: 'POST', body: { contactId: params.id } });
                          setActionMsg(`Portal access granted — sign-in link delivered ${formatTime(new Date())} (sent inline; audited as magic_link.issued). You can send the packet now.`);
                          await load();
                        } catch (err) {
                          setActionErr(err instanceof Error ? err.message : 'Could not grant portal access.');
                        } finally {
                          setBusy(false);
                        }
                      }}
                    >
                      {busy ? 'Working…' : 'Grant portal access first'}
                    </button>
                  ) : p.status === 'draft' ? (
                    <button
                      className="btn accent"
                      type="button"
                      disabled={busy}
                      onClick={async () => {
                        if (!(await ask({ title: 'Send this packet for signature?', body: <p>The client receives it immediately.</p>, choices: [{ key: 'go', label: 'Send for signature', tone: 'primary' }] }))) return;
                        setBusy(true);
                        setActionErr('');
                        try {
                          const res = await api<{ sections: Array<{ code: string | null }>; submissionId?: string }>(
                            `/packets/${p.id}/send`, { method: 'POST', body: {} }
                          );
                          setActionMsg(
                            `Sent for signature. The client was emailed the Master plus ${
                              res.sections.filter((s) => s.code).map((s) => s.code).join(' · ')
                            }.`
                          );
                          await load();
                        } catch (err) {
                          setActionErr(err instanceof Error ? err.message : 'Could not send the packet.');
                        } finally {
                          setBusy(false);
                        }
                      }}
                    >
                      {busy ? 'Sending…' : 'Send for signature'}
                    </button>
                  ) : p.status === 'sent' ? (
                    <span className="muted small">Waiting on the client&apos;s signature.</span>
                  ) : null}
                </span>
              </div>
            ))}
            <p className="muted small">
              A client signs the Master once. Services added later are accepted per-schedule in the
              portal — the Master is never re-executed.
            </p>
          </>
        ) : preview ? (
          <>
            {/* #20: the title already reads "Schedule A — Individual Tax", so prefixing
                the code produced "A — Schedule A — …" both here and in the signed Master.
                Falls back to the bare code only if a title is genuinely missing. */}
            <p className="small">
              <strong>Would contain:</strong>{' '}
              {preview.codes.length === 0
                ? 'nothing yet — no active services'
                : preview.codes.map((c) => preview.titles[c] || c).join(' · ')}
            </p>
            {preview.codes.length > 0 ? (
              <p className="muted small">
                Derived from:{' '}
                {preview.codes
                  .map((c) => `${c} (${(preview.reasons[c] ?? []).join(', ')})`)
                  .join(' · ')}
              </p>
            ) : null}
            <p>
              <button
                className="btn accent"
                type="button"
                disabled={busy || preview.codes.length === 0}
                onClick={async () => {
                  setBusy(true);
                  setActionErr('');
                  try {
                    const res = await api<{ packetId: string; scheduleCodes: string[] }>(
                      `/contacts/${params.id}/packet`, { method: 'POST', body: {} }
                    );
                    setActionMsg(
                      `Packet created with ${res.scheduleCodes.join(' · ')}. Review the document, then send it for signature.`
                    );
                    await load();
                  } catch (err) {
                    setActionErr(err instanceof Error ? err.message : 'Could not create the packet.');
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {busy ? 'Working…' : 'Create engagement packet'}
              </button>
            </p>
          </>
        ) : actionErr ? null : (
          <p className="muted small">Working out what this client needs…</p>
        )}
      </section>

      {/*
        ENGAGEMENTS (#47). This card did not exist: engagements appeared only as a COUNT
        inside the Returns card and as bare service-line names in a dropdown. So the one
        surface where Brian would have seen two identical `tax`/`active` rows never showed
        them side by side — #41 was found on the portal instead.

        Scope is what makes two rows on one service line tell themselves apart, and it is a
        snapshot of the quote lines at acceptance, so this is the agreement speaking rather
        than a title someone typed.
      */}
      {engagements.length > 0 ? (
        <section className="card span" style={{ marginTop: 12 }}>
          <h2>Engagements</h2>
          {/* The result reports HERE, beside the button that caused it — #40's lesson:
              a message at the far end of the page reads as nothing having happened. */}
          {engagements.map((e) => (
            <div className="quote-line" key={e.id}>
              <span className="name">
                {e.scopeName ?? e.title ?? e.service_line}{' '}
                <span className="badge">{engagementStatusLabel(e.status)}</span>
                {e.service_line !== (e.scopeName ?? e.title ?? e.service_line) ? (
                  <span className="badge">{e.service_line}</span>
                ) : null}
                {/* Audit item 1 (2026-09-09): the period, or the control that records it. */}
                {e.period_key ? (
                  <span className="badge" title="The period this engagement covers">
                    {/^\d{4}$/.test(e.period_key) ? `${e.period_key} return` : e.period_key}
                  </span>
                ) : (e.status === 'active' || e.status === 'on_hold') && (e.service_line === 'tax' || e.service_line === 'bookkeeping' || e.service_line === 'payroll') ? (
                  <button
                    type="button"
                    className="badge warn"
                    disabled={busy}
                    title="No period is recorded for this engagement. Set it here (billing)."
                    onClick={async () => {
                      const a = await ask({
                        title: 'Which period does this engagement cover?',
                        body: <p className="small">A tax engagement is a tax year (2025). Recurring work is "ongoing". Another active engagement on the same line and period will refuse the change — withdraw or supersede it first.</p>,
                        reason: { label: 'Period', required: true, placeholder: e.service_line === 'tax' ? '2025' : 'ongoing' },
                        choices: [{ key: 'set', label: 'Record the period', tone: 'primary' }],
                      });
                      if (!a) return;
                      setBusy(true);
                      setActionErr('');
                      try {
                        await api(`/engagements/${e.id}/period`, { method: 'PATCH', body: { periodKey: a.reason, reason: 'Recorded on the client page' } });
                        setActionMsg(`Period recorded: ${a.reason}.`);
                        await load();
                      } catch (err) {
                        setActionErr(err instanceof Error ? err.message : 'Could not record the period.');
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    period not recorded
                  </button>
                ) : null}
              </span>
              <span className="muted small" style={{ flex: '1 1 100%' }}>
                {e.scope.length > 0
                  ? e.scope.filter((s) => !s.isPassThrough).map((s) => s.descriptionEn).join(' · ')
                  : /*
                     * NO BACKFILL, Brian's ruling. These were split from a quote in code
                     * before #47 and the split was never recorded, so what each one covered
                     * is genuinely unknowable. Saying so beats composing a confident guess.
                     */
                    'Scope not recorded — created before scope was captured at acceptance.'}
              </span>
              <span className="muted small" style={{ flex: '1 1 100%' }}>
                started {dayOf(e.created_at)}
                {e.ended_on ? ` · ended ${formatDate(e.ended_on)}` : ''}
                {e.close_reason ? ` · ${e.close_reason}` : ''}
              </span>
              <span className="amt">
                {e.scopeSummary.count > 0 ? formatMoney(e.scopeSummary.totalCents) : '—'}
              </span>
              {/*
                #44 — the controls for the three states that existed in the enum and had no
                way to be reached. A route with no button is the #9/#40 class: wire it or
                do not ship it.

                Each one asks for its reason in a prompt rather than a modal, because the
                reason is REQUIRED on withdraw and on hold and an optional-looking field is
                how a required reason ends up empty. Closed engagements show nothing —
                re-opening is a new engagement, not a button.
              */}
              {e.status === 'active' || e.status === 'on_hold' ? (
                <span className="rowactions">
                  {e.status === 'active' ? (
                    <>
                      <button
                        className="btn ghost small" type="button" disabled={busy}
                        onClick={async () => {
                          const a = await ask({ title: 'Put this engagement on hold?', reason: { label: 'Why is it being held?', required: true }, choices: [{ key: 'hold', label: 'Hold', tone: 'primary' }] });
                          if (!a) return;
                          await runEngagementAction(e.id, 'pause', { reason: a.reason }, 'On hold. The clock stops — waiting time and the price lock both move out by the length of the hold.');
                        }}
                      >
                        Hold
                      </button>
                      <button
                        className="btn ghost small" type="button" disabled={busy}
                        onClick={async () => {
                          const a = await ask({ title: 'Close this engagement as completed?', reason: { label: 'Anything to note about how this finished?', required: false }, choices: [{ key: 'close', label: 'Close as completed', tone: 'primary' }] });
                          if (!a) return;
                          await runEngagementAction(e.id, 'close', { outcome: 'completed', reason: a.reason || undefined }, 'Closed as completed.');
                        }}
                      >
                        Close
                      </button>
                      <button
                        className="btn ghost small" type="button" disabled={busy}
                        onClick={async () => {
                          const first0 = await ask({
                            title: 'Withdraw this engagement?',
                            body: <p>Any sent invoice on it is cancelled and the client is told; drafts are deleted. This is the record.</p>,
                            reason: { label: 'Why is it being withdrawn?', required: true },
                            choices: [{ key: 'withdraw', label: 'Withdraw', tone: 'danger' }],
                          });
                          if (!first0) return;
                          const reason = first0.reason;
                          /*
                           * STRANDED DEPOSITS (item 7a, 2026-09-09). The server refuses a withdrawal
                           * that would leave a paid deposit on dead work. When it does, the person
                           * chooses here — transfer to another open engagement of this client, or a
                           * refund task for billing — and the server validates the choice again.
                           */
                          const first = await runEngagementAction(e.id, 'close', { outcome: 'withdrawn', reason }, 'Withdrawn.');
                          if (first !== 'deposit_would_strand') return;
                          const open = engagements.filter((o) => o.id !== e.id && (o.status === 'active' || o.status === 'on_hold'));
                          const choice = await ask({
                            title: 'This engagement holds a paid deposit',
                            body: (
                              <p>
                                It has credit left. Move it to another open engagement of this client, or raise the refund for
                                billing. Nothing is refunded automatically.
                              </p>
                            ),
                            choices: [
                              ...open.map((o) => ({ key: `transfer:${o.id}`, label: `Move to ${o.scopeName ?? o.title ?? o.service_line}`, tone: 'primary' as const })),
                              { key: 'refund', label: 'Raise the refund', tone: 'danger' as const },
                            ],
                          });
                          if (!choice) return;
                          if (choice.choice === 'refund') {
                            await runEngagementAction(e.id, 'close', { outcome: 'withdrawn', reason, depositAction: 'refund' }, 'Withdrawn — a refund task was raised for billing.');
                            return;
                          }
                          const target = open.find((o) => `transfer:${o.id}` === choice.choice);
                          if (!target) { setActionErr('That engagement is no longer open. Nothing changed.'); return; }
                          await runEngagementAction(
                            e.id, 'close',
                            { outcome: 'withdrawn', reason, depositAction: 'transfer', transferToEngagementId: target.id },
                            `Withdrawn — the deposit moved to ${target.scopeName ?? target.title ?? target.service_line}.`
                          );
                        }}
                      >
                        Withdraw
                      </button>
                    </>
                  ) : (
                    <button
                      className="btn ghost small" type="button" disabled={busy}
                      onClick={() => runEngagementAction(e.id, 'resume', {}, 'Resumed — the held days were given back to the client.')}
                    >
                      Resume
                    </button>
                  )}
                </span>
              ) : null}
            </div>
          ))}
        </section>
      ) : null}

      <section className="card span" style={{ marginTop: 12 }}>
        <h2>Returns</h2>
        {returns.length === 0 ? (
          <>
            {/* The old copy — "No tax engagements." — was accurate and read as a
                contradiction: the client list counts ENGAGEMENTS (service-line
                agreements) while this card counts RETURNS (tax_engagements). Both
                were right. Say which is which, and give the next step. */}
            <p className="muted small">
              No tax return has been created yet.
              {engagements.filter((e) => e.status === 'active').length > 0 ? (
                <>
                  {' '}This client has{' '}
                  <strong>{engagements.filter((e) => e.status === 'active').length} active
                  engagement{engagements.filter((e) => e.status === 'active').length === 1 ? '' : 's'}</strong>{' '}
                  ({engagements.filter((e) => e.status === 'active').map((e) => e.service_line).join(', ')}) —
                  an engagement is the agreement to do the work; a return is the specific year and form.
                  Create the return from the preparer queue once the year and return type are known.
                </>
              ) : null}
            </p>
          </>
        ) : (
          returns.map((t) => (
            <div className="quote-line" key={t.id}>
              <span className="name">
                {t.tax_year} {t.return_type.toUpperCase()}{' '}
                <span className="badge">{t.stage.replaceAll('_', ' ')}</span>
                {t.extension_filed ? <span className="badge warn">extended</span> : null}
              </span>
              <span className="muted small" style={{ flex: '1 1 100%' }}>
                {t.filed_date ? `filed ${formatDate(t.filed_date)}` : 'not filed'}
              </span>
              <span className="amt">
                {t.final_fee_cents !== null
                  ? formatMoney(t.final_fee_cents)
                  : t.estimated_fee_max_cents !== null
                    ? `est. ${formatMoney(t.estimated_fee_max_cents)}`
                    : '—'}
              </span>
            </div>
          ))
        )}
      </section>

      {/* SESSIONS (finding #18) — recordings with what was said in them. The whole
          point is reviewing a conversation without listening to it again, so the
          summary is the body of the row, not a detail behind a click. The transcript
          IS behind a click, because reading one is an audited access. */}

      {/*
        INVOICES (#33). The record could show quotes, packets, returns and sessions and
        say nothing about money, so "how are they doing on payment" meant leaving for
        another screen.

        WHAT IS NOT HERE: any way for staff to take a card. Brian's ruling — staff "take
        payment" means sending the client their pay link, and settlement runs the single
        markInvoicePaid path from #24. The Stripe session is created under the CLIENT's
        own portal session, which is what keeps card data away from us entirely. So the
        action here is Send reminder, and the pay link is shown so it can be read out on
        a call.
      */}
      <section className="card" style={{ marginTop: 12 }}>
        <h2>Invoices ({invoices.length})</h2>
        {invoices.length === 0 ? (
          <p className="muted small">Nothing invoiced yet.</p>
        ) : (
          <ul className="list">
            {invoices.map((inv) => (
              <li key={inv.id}>
                <span className="grow">
                  <strong>{inv.invoice_number}</strong> · {formatMoney(inv.total_cents)}
                  {inv.amount_paid_cents > 0 && inv.status !== 'paid' ? (
                    <span className="muted"> · {formatMoney(inv.amount_paid_cents)} paid</span>
                  ) : null}
                  <br />
                  <span className={`badge ${badgeToneFor(inv.status)}`}>{invoiceStatusLabel(inv.status)}</span>
                  {/* Metadata stacks on a phone (D, 2026-09-09): each piece is its own block under 600px. */}
                  <span className="invoice-meta">
                    {inv.status === 'void' || inv.status === 'refunded' || inv.status === 'partially_refunded' ? (
                      <span className="muted small">
                        {invoiceStatusLine(inv, { money: formatMoney, date: (iso) => dayOf(iso) })}
                      </span>
                    ) : null}
                    {inv.sent_at ? <span className="muted small">sent {dayOf(inv.sent_at)}</span> : null}
                  </span>
                  {/* What actually happened to each client message — from the record, never rounded up. */}
                  {(inv.notices ?? []).map((n) => (
                    <span key={n.outboxId ?? n.auditId ?? n.kind} className="muted small">
                      <br />
                      {describeNotice(n, (iso) => formatTime(iso))}
                    </span>
                  ))}
                  {(inv.notices ?? []).length > 0 ? (
                    <details
                      id={`invoice-${inv.id}-sends`}
                      className="small"
                      onToggle={(e) => {
                        if (!(e.currentTarget as HTMLDetailsElement).open || sendLogs[inv.id]) return;
                        void api<{ rows: SendLogRow[] }>(`/invoices/${inv.id}/sends`)
                          .then((r) => setSendLogs((s) => ({ ...s, [inv.id]: r.rows })))
                          .catch(() => setSendLogs((s) => ({ ...s, [inv.id]: [] })));
                      }}
                    >
                      <summary className="muted small">send log</summary>
                      {sendLogs[inv.id] ? (
                        <ul className="list small send-log">
                          {sendLogs[inv.id]!.map((row) => (
                            <li key={`${row.source}-${row.id}`}>
                              <span className="muted">{formatDateTime(row.at)}</span> · {row.what} · {row.state}
                              {row.detail ? <span className="muted"> · {row.detail}</span> : null}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="muted small">Loading…</p>
                      )}
                    </details>
                  ) : null}
                </span>
                {['paid', 'refunded', 'partially_refunded', 'disputed'].includes(inv.status) ? (
                  <button
                    className="btn ghost"
                    type="button"
                    disabled={busy}
                    title="Pull this charge's refunds from Stripe onto the invoice, through the same path the webhook uses"
                    onClick={async () => {
                      setBusy(true);
                      try {
                        const r = await api<{ status: string; recorded: number }>(`/invoices/${inv.id}/resync-stripe`, { method: 'POST' });
                        setActionMsg(`${inv.invoice_number} re-synced from Stripe: ${r.status}, ${r.recorded} refund(s) newly recorded.`);
                        await load();
                      } catch (e) {
                        setActionErr(e instanceof Error ? e.message : 'Could not re-sync from Stripe.');
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    Re-sync from Stripe
                  </button>
                ) : null}
                {/* Only an invoice that can still be paid gets a reminder and a pay link. */}
                {/* Audit item 3 (2026-09-09): the reminder appears only for sent/overdue, and says the amount it chases. */}
                {inv.status === 'sent' || inv.status === 'overdue' ? (
                  <>
                    <button
                      className="btn ghost"
                      type="button"
                      disabled={busy}
                      onClick={async () => {
                        if (!(await ask({
                          title: `Email ${c.first_name} a reminder for ${inv.invoice_number}?`,
                          body: <p className="small">It chases <strong>{formatMoney(inv.total_cents)}</strong>, with the same pay link the invoice carried.</p>,
                          choices: [{ key: 'go', label: `Send reminder (${formatMoney(inv.total_cents)})`, tone: 'primary' }],
                        }))) return;
                        setBusy(true);
                        setActionErr('');
                        try {
                          const r = await api<{ to: string }>(`/invoices/${inv.id}/remind`, { method: 'POST' });
                          setActionMsg(`Reminder sent to ${r.to}.`);
                          await load();
                        } catch (e) {
                          setActionErr(e instanceof Error ? e.message : 'Could not send the reminder.');
                        } finally {
                          setBusy(false);
                        }
                      }}
                    >
                      Send reminder ({formatMoney(inv.total_cents)})
                    </button>{' '}
                    {/*
                      ITEM 14 (2026-09-09): ONE link per invoice — the tokenized pay link — and it is SENT,
                      never printed. The portal URL that used to sit here "so it could be read out on a
                      call" was a 40-character token nobody reads aloud. Email or text, through the send log.
                    */}
                    {inv.status === 'sent' || inv.status === 'overdue' ? (
                      <button
                        className="btn ghost"
                        type="button"
                        disabled={busy}
                        onClick={async () => {
                          const a = await ask({
                            title: `Send ${c.first_name} the pay link for ${inv.invoice_number}?`,
                            body: <p className="small">One link, the same one the invoice email carried. It goes on the send log.</p>,
                            choices: [
                              { key: 'email', label: 'Email it', tone: 'primary' },
                              { key: 'sms', label: 'Text it', tone: 'ghost' },
                            ],
                          });
                          if (!a) return;
                          setBusy(true);
                          setActionErr('');
                          try {
                            const r = await api<{ to: string; channel: string }>(`/invoices/${inv.id}/pay-link/send`, { method: 'POST', body: { channel: a.choice } });
                            setActionMsg(`Pay link ${r.channel === 'sms' ? 'texted' : 'emailed'} to ${r.to}.`);
                            await load();
                          } catch (e) {
                            setActionErr(e instanceof Error ? e.message : 'Could not send the pay link.');
                          } finally {
                            setBusy(false);
                          }
                        }}
                      >
                        Send the pay link…
                      </button>
                    ) : null}
                    {(inv.status === 'sent' || inv.status === 'overdue') ? (
                      <>
                        {' '}
                        <button
                          className="btn ghost"
                          type="button"
                          disabled={busy}
                          onClick={async () => {
                            const a = await ask({
                              title: `Void ${inv.invoice_number}?`,
                              body: (
                                <p className="small">
                                  It keeps its number, leaves A/R, and the client is told their pay link no longer works. A
                                  paid invoice cannot be voided; refund it instead.
                                </p>
                              ),
                              reason: { label: 'Why (this is the record)', required: true },
                              choices: [{ key: 'void', label: 'Void invoice', tone: 'danger' }],
                            });
                            if (!a) return;
                            if (a.reason.length < 5) { setActionErr('Say why in at least a few words — this is the record.'); return; }
                                setBusy(true);
                                setActionErr('');
                                try {
                                  const r = await api<{ notice: NoticeState | null }>(`/invoices/${inv.id}/void`, {
                                    method: 'POST', body: { reason: a.reason },
                                  });
                                  // The notice's REAL state, from the record: "queued" until the send log says
                                  // delivered. "The client has been told" was a claim, not a fact (2026-09-09).
                                  setActionMsg(
                                    `${inv.invoice_number} is void. ${
                                      r.notice ? describeNotice(r.notice, (iso) => formatTime(iso)) : 'No cancellation notice was queued (no email on file)'
                                    } — see the send log under the invoice.`
                                  );
                                  await load();
                                } catch (e) {
                                  setActionErr(e instanceof Error ? e.message : 'Could not void the invoice.');
                                } finally {
                                  setBusy(false);
                                }
                          }}
                        >
                          Void…
                        </button>
                      </>
                    ) : null}
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/*
        SCHEDULING (#33). The cross-check is enforced in the API, not here: asking for a
        meeting when one is already booked returns 409 with the session, and this screen
        shows that instead of creating a second task. The button cannot double-book even
        if this component forgets to look first.
      */}
      <section className="card" style={{ marginTop: 12 }}>
        <h2>Meetings</h2>
        {nextSession ? (
          <p className="small">
            <span className="badge ok">scheduled</span>{' '}
            Next session {formatDateTime(nextSession.starts_at)}
            {nextSession.is_recurring ? <span className="muted"> · recurring</span> : null}
            <br />
            <span className="muted small">Attach work to this session rather than booking a second one.</span>
          </p>
        ) : (
          <>
            <p className="muted small">Nothing on their calendar.</p>
            <label className="field">
              For which engagement?
              <select value={scheduleEngagementId} onChange={(e) => setScheduleEngagementId(e.target.value)}>
                <option value="">Not specific to one</option>
                {engagements
                  .filter((e) => e.status === 'active')
                  .map((e) => (
                    <option key={e.id} value={e.id}>{e.service_line}</option>
                  ))}
              </select>
            </label>
            <button
              className="btn accent"
              type="button"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setActionErr('');
                try {
                  await api(`/contacts/${params.id}/schedule-session`, {
                    method: 'POST',
                    body: scheduleEngagementId ? { engagementId: scheduleEngagementId } : {},
                  });
                  setActionMsg('Scheduling task created — it is in the owner’s queue with the booking link.');
                  await load();
                } catch (e) {
                  setActionErr(e instanceof Error ? e.message : 'Could not request scheduling.');
                  await load();
                } finally {
                  setBusy(false);
                }
              }}
            >
              Request a meeting
            </button>
          </>
        )}
        {/* Audit item 10 (2026-09-09): recorded sessions live here, under the calendar — one card for
            everything a meeting with this client produced. A row with a transcript says "recorded". */}
        <h3 style={{ marginTop: 14 }}>Recorded ({sessions.length})</h3>
        {sessions.length === 0 ? (
          <p className="muted small">No recorded sessions.</p>
        ) : (
          sessions.map((s) => (
            <div key={s.id} style={{ padding: '10px 0', borderTop: '1px solid var(--line)' }}>
              <p className="small" style={{ margin: 0 }}>
                <span className="badge ok" title="A recorded session: transcript and summary below.">recorded</span>{' '}
                <span className="badge">{s.type.replaceAll('_', ' ')}</span>{' '}
                {s.stalled ? (
                  <span className="badge warn">stalled — re-queued</span>
                ) : s.status !== 'ready' ? (
                  <span className="badge warn">{s.status}</span>
                ) : null}{' '}
                <span className="muted">
                  {(s.started_at ?? s.created_at).slice(0, 10)}
                  {s.duration_seconds
                    ? ` · ${Math.floor(s.duration_seconds / 60)}m ${s.duration_seconds % 60}s`
                    : ''}
                  {s.staff_name ? ` · ${s.staff_name}` : ''}
                </span>
              </p>

              {s.summary ? (
                <p className="small" style={{ margin: '6px 0 0' }}>{s.summary}</p>
              ) : s.stalled ? (
                <p className="muted small" style={{ margin: '6px 0 0' }}>
                  Processing stopped partway through and has been re-queued. It will
                  summarize on the next run.
                </p>
              ) : s.status === 'failed' ? (
                <p className="muted small" style={{ margin: '6px 0 0' }}>
                  This recording could not be processed. Retry below, or check the audio.
                </p>
              ) : (
                <p className="muted small" style={{ margin: '6px 0 0' }}>Still processing…</p>
              )}

              {s.decisions && s.decisions.length > 0 ? (
                <p className="small" style={{ margin: '4px 0 0' }}>
                  <strong>Decisions:</strong> {s.decisions.join(' · ')}
                </p>
              ) : null}
              {s.action_items && s.action_items.length > 0 ? (
                <p className="small" style={{ margin: '4px 0 0' }}>
                  <strong>Action items:</strong> {s.action_items.map((a) => a.text).join(' · ')}
                </p>
              ) : null}
              {s.tax_need ? <span className="badge warn">tax need flagged</span> : null}

              <p className="small" style={{ margin: '6px 0 0' }}>
                {s.has_transcript ? (
                  <button
                    type="button"
                    className="btn ghost"
                    onClick={() => {
                      if (openTranscript?.id === s.id) { setOpenTranscript(null); return; }
                      setTranscriptErr('');
                      void api<{ transcript: { content: string } }>(`/meetings/${s.id}/transcript`)
                        .then((r) => setOpenTranscript({ id: s.id, content: r.transcript.content }))
                        .catch((err: unknown) =>
                          setTranscriptErr(err instanceof Error ? err.message : 'Could not load the transcript.')
                        );
                    }}
                  >
                    {openTranscript?.id === s.id ? 'Hide transcript' : 'Full transcript'}
                  </button>
                ) : null}{' '}
                {s.status !== 'ready' ? (
                  <button
                    type="button"
                    className="btn ghost"
                    onClick={() => {
                      void api(`/meetings/${s.id}/reprocess`, { method: 'POST' })
                        .then(() => setActionMsg('Session re-queued for processing.'))
                        .catch((err: unknown) =>
                          setTranscriptErr(err instanceof Error ? err.message : 'Could not re-queue.')
                        );
                    }}
                  >
                    Retry processing
                  </button>
                ) : null}
                {s.model ? <span className="muted small"> · summary auto-generated — review before relying on it</span> : null}
              </p>

              {openTranscript?.id === s.id ? (
                <pre
                  className="small"
                  style={{
                    whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', marginTop: 8,
                    maxHeight: 320, overflowY: 'auto', background: 'var(--paper)',
                    padding: 10, borderRadius: 8,
                  }}
                >
                  {openTranscript.content}
                </pre>
              ) : null}
            </div>
          ))
        )}
        {transcriptErr ? <p className="alert error small">{transcriptErr}</p> : null}
      </section>

      {c.notes ? (
        <section className="card" style={{ marginTop: 12 }}>
          <h2>Notes</h2>
          <p className="small" style={{ whiteSpace: 'pre-wrap' }}>{c.notes}</p>
        </section>
      ) : null}
    </>
  );
}
