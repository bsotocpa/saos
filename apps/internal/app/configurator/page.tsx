'use client';

// Recurring engagement configurator (v4.2 two-dial model).
//
// The S corp session floor is enforced by the API, not by this page — a UI check
// is a courtesy, never a control. What this page does is DISABLE the cadences
// the floor forbids and say why, so staff never pick an option that is going to
// be refused. If someone gets past the disabled state anyway, the API still says
// no and the message lands in the alert bar.

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, formatMoney, isAuthed } from '../../lib/api';

interface Contact { id: string; first_name: string; last_name: string; email: string | null }
interface Engagement { id: string; service_line: string; status: string; title: string | null }

interface Options {
  sElection: { hasActiveSElection: boolean; reasons: string[] };
  sessionFloor: number;
  prepCadences: Array<{ value: string; perYear: number; priced: boolean; itemCode: string | null }>;
  sessionCadences: Array<{ value: string; perYear: number; allowed: boolean; reason: string | null }>;
}

interface Configured {
  prepCadence: string;
  sessionCadence: string;
  sessionsPerYear: number;
  scopeRung: string | null;
  maintenanceMode: boolean;
  sCorpFloorApplied: boolean;
  monthlyEquivalentCents: number;
  lines: Array<{ itemCode: string; label: string; amountCents: number | null; note: string }>;
}

const RUNGS = [
  { value: '', label: '— no scope rung —' },
  { value: 'registration_setup', label: 'Registration & Setup' },
  { value: 'review_audit', label: 'Review / Audit' },
  { value: 'admin_training', label: 'Admin & Training Support' },
  { value: 'full_management', label: 'Full Management & Compliance' },
];

const pretty = (s: string) => s.replaceAll('_', '-');

export default function ConfiguratorPage() {
  const router = useRouter();
  const [search, setSearch] = useState('');
  const [matches, setMatches] = useState<Contact[]>([]);
  const [contact, setContact] = useState<Contact | null>(null);
  const [engagements, setEngagements] = useState<Engagement[]>([]);
  const [engagementId, setEngagementId] = useState('');
  const [options, setOptions] = useState<Options | null>(null);
  const [prep, setPrep] = useState('monthly');
  const [session, setSession] = useState('quarterly');
  const [rung, setRung] = useState('full_management');
  const [result, setResult] = useState<Configured | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!isAuthed()) router.replace('/login');
  }, [router]);

  useEffect(() => {
    if (search.trim().length < 2) {
      setMatches([]);
      return;
    }
    const handle = setTimeout(() => {
      void api<{ contacts: Contact[] }>(`/contacts?search=${encodeURIComponent(search.trim())}&limit=8`)
        .then((r) => setMatches(r.contacts))
        .catch(() => setMatches([]));
    }, 250);
    return () => clearTimeout(handle);
  }, [search]);

  const pick = useCallback(async (c: Contact) => {
    setContact(c);
    setMatches([]);
    setResult(null);
    setError('');
    try {
      const [o, e] = await Promise.all([
        api<Options>(`/contacts/${c.id}/configurator-options`),
        api<{ engagements: Engagement[] }>(`/engagements?contactId=${c.id}`),
      ]);
      setOptions(o);
      const recurring = e.engagements.filter((x) => x.service_line !== 'tax');
      setEngagements(recurring);
      setEngagementId(recurring[0]?.id ?? '');
      // Start on a cadence the floor allows, so the form is never born invalid.
      const firstAllowed = o.sessionCadences.find((s) => s.allowed && s.perYear <= 4);
      if (firstAllowed) setSession(firstAllowed.value);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  const prepPerYear = options?.prepCadences.find((p) => p.value === prep)?.perYear ?? 0;
  const sessionPerYear = options?.sessionCadences.find((s) => s.value === session)?.perYear ?? 0;
  const sessionTooOften = sessionPerYear > prepPerYear;
  const prepUnpriced = options?.prepCadences.find((p) => p.value === prep)?.priced === false;

  const submit = async (maintenance: boolean) => {
    if (!engagementId) return;
    setBusy(true);
    setError('');
    try {
      const url = maintenance
        ? `/engagements/${engagementId}/maintenance-mode`
        : `/engagements/${engagementId}/configure`;
      const body = maintenance
        ? { sessionCadence: session }
        : { prepCadence: prep, sessionCadence: session, ...(rung ? { scopeRung: rung } : {}) };
      setResult(await api<Configured>(url, { method: 'POST', body }));
    } catch (err) {
      setError((err as Error).message);
      setResult(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h1>Engagement configurator</h1>
      {error ? <div className="alert error">{error}</div> : null}

      <section className="card" style={{ marginBottom: 12 }}>
        <label className="field">
          Client
          {contact ? (
            <span className="chipbar" style={{ marginTop: 4 }}>
              <span className="chip active">
                {contact.first_name} {contact.last_name}
                <button type="button" className="x" onClick={() => { setContact(null); setOptions(null); setResult(null); }} aria-label="Clear">×</button>
              </span>
            </span>
          ) : (
            <input
              type="search"
              value={search}
              placeholder="Search by name, email, or phone"
              onChange={(e) => setSearch(e.target.value)}
            />
          )}
        </label>
        {!contact && matches.length > 0 ? (
          <div className="chipbar">
            {matches.map((m) => (
              <button key={m.id} type="button" className="chip" onClick={() => void pick(m)}>
                {m.first_name} {m.last_name}
              </button>
            ))}
          </div>
        ) : null}
      </section>

      {options ? (
        <>
          {options.sElection.hasActiveSElection ? (
            <div className="alert warn">
              <strong>Active S election — {options.sessionFloor}-session floor applies.</strong> Owner
              compensation and estimated payments both need touching, so this client cannot be configured
              below {options.sessionFloor} CPA sessions a year. Annual sessions are disabled below.
              <br />
              <span className="small">Evidence: {options.sElection.reasons.join('; ')}</span>
            </div>
          ) : null}

          <section className="card" style={{ marginBottom: 12 }}>
            <h2>Two dials + scope</h2>
            {engagements.length === 0 ? (
              <div className="alert info">
                This client has no recurring engagement yet. Create a bookkeeping, advisory, payroll, or
                COO engagement first — tax engagements are per-return and have no cadence.
              </div>
            ) : (
              <label className="field">
                Engagement
                <select value={engagementId} onChange={(e) => setEngagementId(e.target.value)}>
                  {engagements.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.service_line} — {e.title ?? 'untitled'} ({e.status})
                    </option>
                  ))}
                </select>
              </label>
            )}

            <div className="grid2">
              <label className="field">
                Dial 1 — prep cadence (books close)
                <select value={prep} onChange={(e) => setPrep(e.target.value)}>
                  {options.prepCadences.map((p) => (
                    <option key={p.value} value={p.value}>
                      {pretty(p.value)} · {p.perYear}/yr{p.priced ? '' : ' — not in the price book'}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                Dial 2 — session cadence (CPA time)
                <select value={session} onChange={(e) => setSession(e.target.value)}>
                  {options.sessionCadences.map((s) => (
                    <option key={s.value} value={s.value} disabled={!s.allowed}>
                      {pretty(s.value)} · {s.perYear}/yr{s.allowed ? '' : ' — below the floor'}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label className="field">
              Scope rung
              <select value={rung} onChange={(e) => setRung(e.target.value)}>
                {RUNGS.map((r) => (
                  <option key={r.value} value={r.value}>{r.label}</option>
                ))}
              </select>
            </label>

            {sessionTooOften ? (
              <div className="alert error">
                Sessions ({sessionPerYear}/yr) cannot be more frequent than the books close
                ({prepPerYear}/yr) — there is nothing to review in a session whose books have not closed.
              </div>
            ) : null}
            {prepUnpriced ? (
              <div className="alert warn">
                The price book in force has no {pretty(prep)} line, so this configuration cannot be
                priced. Add the item in Admin → Pricing first.
              </div>
            ) : null}

            <div className="chipbar">
              <button
                type="button"
                className="btn accent"
                disabled={busy || !engagementId || sessionTooOften || prepUnpriced}
                onClick={() => void submit(false)}
              >
                Save configuration
              </button>
              <button
                type="button"
                className="btn ghost"
                disabled={busy || !engagementId}
                onClick={() => void submit(true)}
                title="Hold the prep cadence, reduce sessions"
              >
                Move to maintenance mode
              </button>
            </div>
            <p className="muted small">
              Maintenance mode holds the books cadence and reduces sessions — a positive, cheaper state
              for a client who does not need as much CPA time. It runs through the same floor check.
            </p>
          </section>
        </>
      ) : null}

      {result ? (
        <section className="card">
          <h2>
            Configured{' '}
            {result.maintenanceMode ? <span className="badge warn">maintenance mode</span> : null}{' '}
            {result.sCorpFloorApplied ? <span className="badge">S corp floor applied</span> : null}
          </h2>
          <p className="small">
            Books {pretty(result.prepCadence)} · {result.sessionsPerYear} CPA session
            {result.sessionsPerYear === 1 ? '' : 's'} a year ({pretty(result.sessionCadence)})
            {result.scopeRung ? ` · ${pretty(result.scopeRung)}` : ''}
          </p>
          <p className="small">
            <strong>{formatMoney(result.monthlyEquivalentCents)}/month equivalent</strong>
          </p>
          {result.lines.map((l) => (
            <div className="quote-line" key={`${l.itemCode}-${l.label}`}>
              <span className="name">{l.label}</span>
              <span className="muted small" style={{ flex: '1 1 100%' }}>{l.note}</span>
              <span className="amt">{l.amountCents === null ? '—' : formatMoney(l.amountCents)}</span>
            </div>
          ))}
        </section>
      ) : null}
    </>
  );
}
