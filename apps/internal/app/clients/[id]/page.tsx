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

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { api, formatMoney, isAuthed } from '../../../lib/api';

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
  id: string; status: string; total_cents: number; range_min_cents: number | null;
  range_max_cents: number | null; created_at: string;
}
interface Engagement {
  id: string; service_line: string; status: string; title: string | null; created_at: string;
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
}
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
  const [packetMsg, setPacketMsg] = useState('');
  const [packetErr, setPacketErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
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
          .then((r) => { setPreview(r); setPacketErr(''); })
          .catch((err: unknown) => {
            setPreview(null);
            setPacketErr(err instanceof Error ? err.message : 'Could not work out the packet.');
          }),
      ]);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [params.id]);

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
          <span className={`badge ${okBadge(c.consent_7216_status)}`}>{c.consent_7216_status}</span>{' '}
          §7216 consent
        </p>
        <p className="small" style={{ margin: '4px 0' }}>
          <span className={`badge ${okBadge(c.engagement_letter_status)}`}>{c.engagement_letter_status}</span>{' '}
          Engagement letter
        </p>
        {!consentOk || !letterOk ? (
          <p className="muted small">
            Work can be prepared, but nothing client-facing sends and no return is delivered until both are
            on file. The send paths refuse it rather than relying on anyone remembering.
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
          {actionMsg ? <p className="alert ok">{actionMsg}</p> : null}
          {actionErr ? <p className="alert warn">{actionErr}</p> : null}
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
            {c.portal_state === 'active' && c.portal_last_login_at ? (
              <span className="muted"> · last signed in {new Date(c.portal_last_login_at).toLocaleDateString()}</span>
            ) : null}
            {c.portal_state === 'invited' && c.portal_link_sent_at ? (
              <span className="muted">
                {' · link sent '}{new Date(c.portal_link_sent_at).toLocaleString()}
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
                if (!window.confirm(
                  first
                    ? 'Grant portal access? The client is emailed a secure sign-in link and a welcome.'
                    : 'Send another sign-in link? The previous one stops working.'
                )) return;
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
                <span className="muted"> · {d.created_at.slice(0, 10)}</span>
              </p>
            ))
          )}
          {docs.length > 12 ? <p className="muted small">+{docs.length - 12} more</p> : null}
        </section>

        <section className="card">
          <h2>Quotes</h2>
          {quotes.length === 0 ? (
            <p className="muted small">No quotes sent.</p>
          ) : (
            quotes.slice(0, 6).map((q) => (
              <p key={q.id} className="small" style={{ margin: '3px 0' }}>
                <span className={`badge ${q.status === 'accepted' ? 'ok' : q.status === 'sent' ? '' : 'warn'}`}>
                  {q.status}
                </span>{' '}
                {q.range_min_cents !== null && q.range_max_cents !== null
                  ? `${formatMoney(q.range_min_cents)}–${formatMoney(q.range_max_cents)}`
                  : formatMoney(q.total_cents)}
                <span className="muted"> · {q.created_at.slice(0, 10)}</span>
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
        {packetMsg ? <p className="alert ok">{packetMsg}</p> : null}
        {packetErr ? (
          <>
            <p className="alert warn">{packetErr}</p>
            <p className="muted small">
              Nothing is papered yet. Fix the reason above and reload — the packet is assembled from
              the client&apos;s active services, so it needs at least one.
            </p>
          </>
        ) : null}

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
                  created {p.created_at.slice(0, 10)}
                  {p.sent_at ? ` · sent ${p.sent_at.slice(0, 10)}` : ''}
                  {p.signed_at ? ` · signed ${p.signed_at.slice(0, 10)}` : ''}
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
                        if (!window.confirm(
                          'Grant portal access? The client is emailed a secure sign-in link.'
                        )) return;
                        setBusy(true);
                        setPacketErr('');
                        try {
                          await api('/portal-users', { method: 'POST', body: { contactId: params.id } });
                          setPacketMsg('Portal access granted — the client was emailed a sign-in link. You can send the packet now.');
                          await load();
                        } catch (err) {
                          setPacketErr(err instanceof Error ? err.message : 'Could not grant portal access.');
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
                        if (!window.confirm(
                          'Send this packet for signature? The client receives it immediately.'
                        )) return;
                        setBusy(true);
                        setPacketErr('');
                        try {
                          const res = await api<{ sections: Array<{ code: string | null }>; submissionId?: string }>(
                            `/packets/${p.id}/send`, { method: 'POST', body: {} }
                          );
                          setPacketMsg(
                            `Sent for signature. The client was emailed the Master plus ${
                              res.sections.filter((s) => s.code).map((s) => s.code).join(' · ')
                            }.`
                          );
                          await load();
                        } catch (err) {
                          setPacketErr(err instanceof Error ? err.message : 'Could not send the packet.');
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
                  setPacketErr('');
                  try {
                    const res = await api<{ packetId: string; scheduleCodes: string[] }>(
                      `/contacts/${params.id}/packet`, { method: 'POST', body: {} }
                    );
                    setPacketMsg(
                      `Packet created with ${res.scheduleCodes.join(' · ')}. Review the document, then send it for signature.`
                    );
                    await load();
                  } catch (err) {
                    setPacketErr(err instanceof Error ? err.message : 'Could not create the packet.');
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {busy ? 'Working…' : 'Create engagement packet'}
              </button>
            </p>
          </>
        ) : packetErr ? null : (
          <p className="muted small">Working out what this client needs…</p>
        )}
      </section>

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
                {t.filed_date ? `filed ${t.filed_date}` : 'not filed'}
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
      <section className="card span" style={{ marginTop: 12 }}>
        <h2>Sessions ({sessions.length})</h2>
        {sessions.length === 0 ? (
          <p className="muted small">No recorded sessions.</p>
        ) : (
          sessions.map((s) => (
            <div key={s.id} style={{ padding: '10px 0', borderTop: '1px solid var(--line)' }}>
              <p className="small" style={{ margin: 0 }}>
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
                        .then(() => setPacketMsg('Session re-queued for processing.'))
                        .catch((err: unknown) =>
                          setTranscriptErr(err instanceof Error ? err.message : 'Could not re-queue.')
                        );
                    }}
                  >
                    Retry processing
                  </button>
                ) : null}
                {s.model ? <span className="muted small"> · summarized by {s.model}</span> : null}
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
        {actionMsg ? <p className="alert ok">{actionMsg}</p> : null}
        {actionErr ? <p className="alert warn">{actionErr}</p> : null}
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
                  <span className={`badge ${inv.status === 'paid' ? 'ok' : inv.status === 'overdue' ? 'warn' : ''}`}>
                    {inv.status}
                  </span>
                  {inv.sent_at ? <span className="muted small"> sent {new Date(inv.sent_at).toLocaleDateString()}</span> : null}
                </span>
                {inv.status !== 'paid' && inv.status !== 'void' ? (
                  <>
                    <button
                      className="btn ghost"
                      type="button"
                      disabled={busy}
                      onClick={async () => {
                        if (!window.confirm(`Email ${c.first_name} a reminder for ${inv.invoice_number}?`)) return;
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
                      Send reminder
                    </button>{' '}
                    {/* The client's own pay screen. Read it to them; do not take the card. */}
                    <span className="muted small" style={{ overflowWrap: 'anywhere' }}>
                      {packet.portalBaseUrl}/invoices?invoice={inv.id}
                    </span>
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
        {actionMsg ? <p className="alert ok">{actionMsg}</p> : null}
        {actionErr ? <p className="alert warn">{actionErr}</p> : null}
        {nextSession ? (
          <p className="small">
            <span className="badge ok">scheduled</span>{' '}
            Next session {new Date(nextSession.starts_at).toLocaleString()}
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
