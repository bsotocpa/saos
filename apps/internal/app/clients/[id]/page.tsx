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
  soto_status: string; hilo_status: string; client_since: string | null;
  consent_7216_status: string; engagement_letter_status: string;
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
interface PacketRow {
  id: string; status: string; schedule_codes: string[];
  sent_at: string | null; signed_at: string | null; created_at: string;
}

const okBadge = (s: string) => (s === 'signed' || s === 'granted' || s === 'on_file' ? 'ok' : 'warn');

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
        api<{ packets: PacketRow[] }>(`/contacts/${params.id}/packets`)
          .then((r) => setPackets(r.packets ?? []))
          .catch(() => setPackets([])),
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
  const consentOk = c.consent_7216_status === 'granted' || c.consent_7216_status === 'on_file';
  const letterOk = c.engagement_letter_status === 'signed';

  return (
    <>
      <h1>
        {c.first_name} {c.last_name}
      </h1>
      <p className="muted small">
        {c.soto_status}
        {c.hilo_status !== 'none' ? ` · Hilo: ${c.hilo_status}` : ''}
        {c.client_since ? ` · client since ${c.client_since}` : ''}
        {' · from '}{c.source}
      </p>

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
          <h2>Contact</h2>
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
              </div>
            ))}
            <p className="muted small">
              A client signs the Master once. Services added later are accepted per-schedule in the
              portal — the Master is never re-executed.
            </p>
          </>
        ) : preview ? (
          <>
            <p className="small">
              <strong>Would contain:</strong>{' '}
              {preview.codes.length === 0
                ? 'nothing yet — no active services'
                : preview.codes.map((c) => `${c} — ${preview.titles[c] ?? ''}`).join(' · ')}
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

      {c.notes ? (
        <section className="card" style={{ marginTop: 12 }}>
          <h2>Notes</h2>
          <p className="small" style={{ whiteSpace: 'pre-wrap' }}>{c.notes}</p>
        </section>
      ) : null}
    </>
  );
}
