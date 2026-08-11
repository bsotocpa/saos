'use client';

// Leads pipeline + quote builder (M27).
//
// The builder composes ONLY from the price book in force — the catalog it lists
// is the book, and the API refuses any code that isn't in it. Sending pins the
// version, so a price change tomorrow never re-prices a proposal a client is
// reading today.

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api, isAuthed } from '../../lib/api';

interface CatalogItem {
  item_code: string;
  service_line: string;
  name_en: string;
  amount_cents: number | null;
  price_min_cents: number | null;
  price_max_cents: number | null;
  unit: string | null;
  is_pass_through: boolean;
  needs_confirmation: boolean;
}
interface CatalogBundle { slug: string; name_en: string; component_count: number }
interface Contact { id: string; first_name: string; last_name: string; email: string | null }

interface BoardRow {
  id: string;
  first_name: string;
  last_name: string;
  email: string | null;
  lead_stage: string;
  lead_stage_at: string | null;
  lost_reason: string | null;
  /** Workable here, but excluded from every number on this page. */
  is_test: boolean;
  quote_id: string | null;
  quote_status: string | null;
  total_cents: number | null;
  range_min_cents: number | null;
  range_max_cents: number | null;
  sent_at: string | null;
  expires_at: string | null;
}

interface Metrics {
  byStage: Array<{ stage: string; count: number }>;
  quotesSent: number;
  quotesAccepted: number;
  quotesDeclined: number;
  quotesExpired: number;
  quotesOpen: number;
  winRatePercent: number | null;
  acceptedValueCents: number;
  openValueCents: number;
  medianDaysToDecision: number | null;
  lostReasons: Array<{ reason: string; count: number }>;
}

const STAGES = ['call_booked', 'quoted', 'deposit_paid', 'onboarding', 'lost'] as const;
const STAGE_LABEL: Record<string, string> = {
  call_booked: 'Call booked',
  quoted: 'Quoted',
  deposit_paid: 'Deposit paid',
  onboarding: 'Onboarding',
  client: 'Client',
  lost: 'Lost',
};

const money = (cents: number | null) =>
  cents === null ? '—' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);

export default function PipelinePage() {
  const router = useRouter();
  const [board, setBoard] = useState<BoardRow[]>([]);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [bundles, setBundles] = useState<CatalogBundle[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // Builder state
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [matches, setMatches] = useState<Contact[]>([]);
  const [contact, setContact] = useState<Contact | null>(null);
  const [language, setLanguage] = useState<'en' | 'es'>('en');
  const [bundleSlug, setBundleSlug] = useState('');
  const [picked, setPicked] = useState<Array<{ itemCode: string; quantity: number; isOptional: boolean }>>([]);
  const [itemFilter, setItemFilter] = useState('');
  const [depositItemCode, setDepositItemCode] = useState('');
  const [asRange, setAsRange] = useState(true);
  const [expiresInDays, setExpiresInDays] = useState(30);
  const [notes, setNotes] = useState('');
  const [sentLink, setSentLink] = useState('');
  /**
   * The send confirmation is its OWN state, deliberately outside the builder.
   * It used to live inside the builder modal, so resetBuilder() wiped it the moment
   * the composer closed — Brian sent a quote, lost the confirmation, could not tell
   * whether it had gone, and built a second one. A confirmation that vanishes is
   * not a confirmation.
   */
  const [sentConfirm, setSentConfirm] = useState<
    { url: string; name: string; totalCents: number | null } | null
  >(null);
  /** Open (sent, undecided) quotes for the selected client — the duplicate guard. */
  const [openQuotes, setOpenQuotes] = useState<
    Array<{ id: string; status: string; total_cents: number; created_at: string }>
  >([]);
  const [dupAcknowledged, setDupAcknowledged] = useState(false);
  // A saved draft awaiting a deliberate deposit decision, then sending.
  const [draftQuoteId, setDraftQuoteId] = useState('');
  const [depositOverride, setDepositOverride] = useState<
    { standardCents: number; chargeCents: number; treatment: string } | null
  >(null);
  const [canOverrideDeposit, setCanOverrideDeposit] = useState(false);

  const load = useCallback(async () => {
    try {
      const [p, c] = await Promise.all([
        api<{ board: BoardRow[]; metrics: Metrics }>('/pipeline'),
        api<{ items: CatalogItem[]; bundles: CatalogBundle[] }>('/quotes/catalog'),
      ]);
      setBoard(p.board);
      setMetrics(p.metrics);
      setCatalog(c.items);
      setBundles(c.bundles);
      // `deposits.override` is explicit-only, so a '*' role does NOT imply it —
      // check for the key itself, exactly as the API does.
      const me = await api<{ permissions: string[] }>('/auth/me');
      setCanOverrideDeposit(me.permissions.includes('deposits.override'));
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    if (!isAuthed()) {
      router.replace('/login');
      return;
    }
    void load();
  }, [router, load]);

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

  /**
   * DUPLICATE GUARD. Brian sent two quotes to the same client because nothing told
   * him the first had gone through in a way that stuck. Selecting a client now
   * surfaces any quote already out with them, before the builder will send another.
   */
  const loadOpenQuotes = useCallback(async (contactId: string) => {
    setDupAcknowledged(false);
    try {
      const r = await api<{ quotes: Array<{ id: string; status: string; total_cents: number; created_at: string }> }>(
        `/contacts/${contactId}/quotes`
      );
      setOpenQuotes((r.quotes ?? []).filter((q) => q.status === 'sent'));
    } catch {
      setOpenQuotes([]);
    }
  }, []);

  const deposits = useMemo(() => catalog.filter((i) => i.service_line === 'deposit'), [catalog]);
  const filtered = useMemo(() => {
    const q = itemFilter.trim().toLowerCase();
    const base = catalog.filter((i) => i.service_line !== 'deposit');
    if (q.length === 0) return base.slice(0, 40);
    return base.filter((i) => i.name_en.toLowerCase().includes(q) || i.item_code.toLowerCase().includes(q)).slice(0, 40);
  }, [catalog, itemFilter]);

  const runningTotal = picked.reduce((sum, p) => {
    if (p.isOptional) return sum;
    const item = catalog.find((i) => i.item_code === p.itemCode);
    return sum + (item?.amount_cents ?? 0) * p.quantity;
  }, 0);
  const unconfirmed = picked.filter((p) => catalog.find((i) => i.item_code === p.itemCode)?.needs_confirmation);

  const addItem = (code: string) => {
    setPicked((prev) =>
      prev.some((p) => p.itemCode === code) ? prev : [...prev, { itemCode: code, quantity: 1, isOptional: false }]
    );
  };

  /**
   * Deposit override. Deliberately NOT an inline editable field on the builder:
   * the standard deposit is what happens unless someone chooses otherwise, and
   * that choice needs a confirm step and a reason. Only visible to staff who hold
   * `deposits.override` — and the API refuses it regardless of what the UI shows.
   */
  const overrideDeposit = async (quoteId: string, waive: boolean) => {
    const standard = deposits.find((d) => d.item_code === depositItemCode)?.amount_cents ?? 0;
    let amountCents = 0;
    if (!waive) {
      const entered = window.prompt(
        `Reduced deposit in dollars (standard is ${money(standard)}). Enter 0 to waive entirely.`,
        ''
      );
      if (entered === null) return;
      const parsed = Number(entered.replace(/[^0-9.]/g, ''));
      if (!Number.isFinite(parsed) || parsed < 0) {
        setError('Enter a dollar amount of 0 or more.');
        return;
      }
      amountCents = Math.round(parsed * 100);
    }
    const reason = window.prompt(
      waive
        ? 'Why is this deposit being waived? (recorded against the engagement, min 10 characters)'
        : 'Why is this deposit being reduced? (recorded against the engagement, min 10 characters)',
      ''
    );
    if (reason === null) return;
    if (reason.trim().length < 10) {
      setError('The reason is the record — please write at least a few words.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const r = await api<{ standardCents: number; chargeCents: number; treatment: string }>(
        `/quotes/${quoteId}/deposit-override`,
        { method: 'POST', body: { amountCents, reason: reason.trim() } }
      );
      setDepositOverride(r);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const resetBuilder = () => {
    setContact(null); setSearch(''); setBundleSlug(''); setPicked([]);
    setDepositItemCode(''); setNotes(''); setSentLink(''); setItemFilter('');
    setDraftQuoteId(''); setDepositOverride(null);
  };

  const sendDraft = async () => {
    if (!draftQuoteId) return;
    setBusy(true);
    setError('');
    try {
      const r = await api<{ url: string }>(`/quotes/${draftQuoteId}/send`, { method: 'POST' });
      setSentLink(r.url);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const buildAndSend = async (send: boolean) => {
    if (!contact) return;
    setBusy(true);
    setError('');
    try {
      const created = await api<{ id: string }>('/quotes', {
        method: 'POST',
        body: {
          contactId: contact.id,
          language,
          ...(bundleSlug ? { bundleSlug } : { lines: picked }),
          ...(bundleSlug ? { includeOptional: picked.filter((p) => p.isOptional).map((p) => p.itemCode) } : {}),
          ...(depositItemCode ? { depositItemCode } : {}),
          asRange,
          expiresInDays,
          ...(notes.trim() ? { notes: notes.trim() } : {}),
        },
      });
      if (send) {
        const r = await api<{ url: string }>(`/quotes/${created.id}/send`, { method: 'POST' });
        setSentLink(r.url);
        setSentConfirm({
          url: r.url,
          name: `${contact.first_name} ${contact.last_name}`,
          totalCents: null,
        });
        setOpen(false);
        resetBuilder();
      } else {
        // Saving a draft keeps the composer open so the deposit can be adjusted
        // deliberately before the client ever sees the quote.
        setDraftQuoteId(created.id);
        setDepositOverride(null);
      }
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const stageCount = (stage: string) => metrics?.byStage.find((s) => s.stage === stage)?.count ?? 0;

  return (
    <>
      <h1>Pipeline</h1>
      {error ? <div className="alert error">{error}</div> : null}

      {/* THE SEND CONFIRMATION. Its own modal, outside the builder, dismissed only
          by an explicit click — the previous version lived inside the composer and
          was wiped by resetBuilder(), so the send left no trace and a second quote
          got built. It stays until Brian says he has seen it. */}
      {sentConfirm ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Quote sent"
          style={{
            position: "fixed", inset: 0, zIndex: 50, display: "flex",
            alignItems: "center", justifyContent: "center", padding: 16,
            background: "rgba(13, 59, 56, 0.45)",
          }}
        >
          <div className="modal" style={{ maxWidth: 560 }}>
            <h2>Quote sent to {sentConfirm.name}</h2>
            <p className="alert ok" style={{ marginBottom: 8 }}>
              The proposal email is on its way, and the quote is now open awaiting their decision.
            </p>
            <p className="small muted">Their link (also emailed):</p>
            <p>
              <code style={{ overflowWrap: 'anywhere' }}>{sentConfirm.url}</code>
            </p>
            <p className="muted small">
              You do not need to send another. If you want to change it, open the client and edit or
              resend this one — a second quote means they can accept both.
            </p>
            <p>
              <button
                type="button"
                className="btn accent"
                onClick={() => { void navigator.clipboard?.writeText(sentConfirm.url); }}
              >
                Copy link
              </button>{' '}
              <Link className="btn ghost" href={`/clients/${contact?.id ?? ''}`}>Open the client</Link>{' '}
              <button type="button" className="btn ghost" onClick={() => { setSentConfirm(null); setSentLink(''); }}>
                Dismiss
              </button>
            </p>
          </div>
        </div>
      ) : null}

      <div className="chipbar">
        <button type="button" className="btn accent" onClick={() => setOpen((o) => !o)}>
          {open ? 'Close builder' : 'New quote'}
        </button>
        {metrics ? (
          <span className="muted small">
            {metrics.quotesOpen} open · {money(metrics.openValueCents)} in play ·{' '}
            {metrics.winRatePercent === null ? 'no decided quotes yet' : `${metrics.winRatePercent}% win rate`}
            {metrics.medianDaysToDecision !== null ? ` · ${metrics.medianDaysToDecision}d median to decide` : ''}
          </span>
        ) : null}
      </div>

      {open ? (
        <section className="card span" style={{ marginBottom: 12 }}>
          <h2>Build a quote</h2>
          <p className="muted small">
            Every line comes from price book in force. Optional lines are the client&apos;s choice and are
            excluded from the total until they tick them.
          </p>

          {/* DUPLICATE GUARD: a quote is already out with this client. Surfaced
              before anything else in the composer, with the existing one offered
              first — sending a second is a deliberate act, not the default. */}
          {contact && openQuotes.length > 0 && !dupAcknowledged ? (
            <div className="alert warn">
              <strong>
                {contact.first_name} {contact.last_name} already has{' '}
                {openQuotes.length === 1 ? 'a quote' : `${openQuotes.length} quotes`} out.
              </strong>
              {openQuotes.map((q) => (
                <p key={q.id} className="small" style={{ margin: '6px 0' }}>
                  {money(q.total_cents)} · sent {q.created_at.slice(0, 10)} · awaiting their decision
                </p>
              ))}
              <p className="muted small">
                Sending another means they receive two live proposals and can accept both. Pick one:
              </p>
              <p>
                <Link className="btn ghost" href={`/clients/${contact.id}`}>Open the client</Link>{' '}
                <button
                  type="button"
                  className="btn ghost"
                  onClick={() => { setContact(null); setOpenQuotes([]); }}
                >
                  Choose a different client
                </button>{' '}
                <button
                  type="button"
                  className="btn"
                  onClick={() => setDupAcknowledged(true)}
                >
                  Create another anyway
                </button>
              </p>
            </div>
          ) : sentLink ? (
            <div className="alert ok">
              Sent. The client link (also emailed):{' '}
              <code style={{ overflowWrap: 'anywhere' }}>{sentLink}</code>
              <br />
              <button
                type="button"
                className="btn ghost"
                style={{ marginTop: 8 }}
                onClick={() => { setOpen(false); resetBuilder(); }}
              >
                Done
              </button>
            </div>
          ) : (
            <>
              <label className="field">
                Client or lead
                {contact ? (
                  <span className="chipbar" style={{ marginTop: 4 }}>
                    <span className="chip active">
                      {contact.first_name} {contact.last_name}
                      <button type="button" className="x" onClick={() => { setContact(null); setOpenQuotes([]); setDupAcknowledged(false); }} aria-label="Clear">×</button>
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
                    <button key={m.id} type="button" className="chip" onClick={() => { setContact(m); setMatches([]); void loadOpenQuotes(m.id); }}>
                      {m.first_name} {m.last_name}
                    </button>
                  ))}
                </div>
              ) : null}

              <div className="grid2">
                <label className="field">
                  Language
                  <select value={language} onChange={(e) => setLanguage(e.target.value as 'en' | 'es')}>
                    <option value="en">English</option>
                    <option value="es">Español</option>
                  </select>
                </label>
                <label className="field">
                  Package (optional)
                  <select value={bundleSlug} onChange={(e) => { setBundleSlug(e.target.value); setPicked([]); }}>
                    <option value="">— build line by line —</option>
                    {bundles.map((b) => (
                      <option key={b.slug} value={b.slug}>{b.name_en} ({b.component_count} items)</option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  Deposit item
                  <select value={depositItemCode} onChange={(e) => setDepositItemCode(e.target.value)}>
                    <option value="">— no deposit —</option>
                    {deposits.map((d) => (
                      <option key={d.item_code} value={d.item_code}>{d.name_en} · {money(d.amount_cents)}</option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  Good for (days)
                  <input
                    type="number"
                    min={1}
                    max={365}
                    value={expiresInDays}
                    onChange={(e) => setExpiresInDays(Math.max(1, Math.min(365, Number(e.target.value) || 30)))}
                  />
                </label>
              </div>

              <label className="field inline-check">
                <input type="checkbox" checked={asRange} onChange={(e) => setAsRange(e.target.checked)} />
                <span>Quote as a range (one-time work). Uncheck for recurring work, which quotes exact.</span>
              </label>

              {bundleSlug ? (
                <p className="muted small">
                  The package composes itself from its price-book components when the quote is created.
                </p>
              ) : (
                <>
                  <label className="field">
                    Add services
                    <input
                      type="search"
                      value={itemFilter}
                      placeholder="Filter the price book"
                      onChange={(e) => setItemFilter(e.target.value)}
                    />
                  </label>
                  <div className="chipbar">
                    {filtered.map((i) => (
                      <button key={i.item_code} type="button" className="chip" onClick={() => addItem(i.item_code)}>
                        {i.name_en} · {money(i.amount_cents)}
                        {i.needs_confirmation ? ' ⚠' : ''}
                      </button>
                    ))}
                  </div>

                  {picked.map((p, idx) => {
                    const item = catalog.find((i) => i.item_code === p.itemCode);
                    return (
                      <div className="quote-line" key={p.itemCode}>
                        <span className="name">{item?.name_en ?? p.itemCode}</span>
                        <label className="ctl">
                          Qty
                          <input
                            type="number"
                            min={1}
                            max={99}
                            value={p.quantity}
                            onChange={(e) =>
                              setPicked((prev) =>
                                prev.map((x, i) =>
                                  i === idx ? { ...x, quantity: Math.max(1, Number(e.target.value) || 1) } : x
                                )
                              )
                            }
                          />
                        </label>
                        <label className="ctl">
                          <input
                            type="checkbox"
                            checked={p.isOptional}
                            onChange={(e) =>
                              setPicked((prev) =>
                                prev.map((x, i) => (i === idx ? { ...x, isOptional: e.target.checked } : x))
                              )
                            }
                          />
                          Optional
                        </label>
                        <button
                          type="button"
                          className="chip"
                          onClick={() => setPicked((prev) => prev.filter((_, i) => i !== idx))}
                        >
                          Remove
                        </button>
                        <span className="amt">
                          {p.isOptional ? '—' : money((item?.amount_cents ?? 0) * p.quantity)}
                        </span>
                      </div>
                    );
                  })}
                  <p className="small">
                    <strong>Committed total: {money(runningTotal)}</strong>
                    {asRange ? ' (a range is applied when the quote is built)' : ''}
                  </p>
                  {unconfirmed.length > 0 ? (
                    <div className="alert warn">
                      {unconfirmed.length} line{unconfirmed.length === 1 ? '' : 's'} still awaiting your price
                      confirmation: {unconfirmed.map((p) => p.itemCode).join(', ')}. The quote will use the
                      seeded figure — confirm in Admin → Pricing first if that number is wrong.
                    </div>
                  ) : null}
                </>
              )}

              <label className="field">
                Note to the client (optional)
                <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
              </label>

              <div className="chipbar">
                <button
                  type="button"
                  className="btn accent"
                  disabled={busy || !contact || (!bundleSlug && picked.length === 0)}
                  onClick={() => void buildAndSend(true)}
                >
                  Create and send
                </button>
                <button
                  type="button"
                  className="btn ghost"
                  disabled={busy || !contact || (!bundleSlug && picked.length === 0)}
                  onClick={() => void buildAndSend(false)}
                >
                  Save as draft
                </button>
              </div>

              {/* Deposit decision on a saved draft. The standard deposit is what
                  happens by default — this panel only appears once a draft
                  exists, and only for staff holding deposits.override. */}
              {draftQuoteId ? (
                <div className="alert info" style={{ marginTop: 4 }}>
                  <strong>Draft saved.</strong>{' '}
                  {depositItemCode ? (
                    depositOverride ? (
                      <>
                        Deposit is{' '}
                        <strong>
                          {depositOverride.treatment === 'waived'
                            ? 'WAIVED'
                            : `${money(depositOverride.chargeCents)} (standard ${money(depositOverride.standardCents)})`}
                        </strong>{' '}
                        — recorded against the engagement for A/R.
                      </>
                    ) : (
                      <>Standard deposit applies.</>
                    )
                  ) : (
                    <>No deposit on this quote.</>
                  )}
                  <div className="chipbar" style={{ marginTop: 8, marginBottom: 0 }}>
                    <button type="button" className="btn accent" disabled={busy} onClick={() => void sendDraft()}>
                      Send to client
                    </button>
                    {canOverrideDeposit && depositItemCode ? (
                      <>
                        <button
                          type="button"
                          className="chip"
                          disabled={busy}
                          onClick={() => void overrideDeposit(draftQuoteId, false)}
                        >
                          Reduce deposit…
                        </button>
                        <button
                          type="button"
                          className="chip"
                          disabled={busy}
                          onClick={() => void overrideDeposit(draftQuoteId, true)}
                        >
                          Waive deposit…
                        </button>
                      </>
                    ) : null}
                  </div>
                  {canOverrideDeposit && depositItemCode ? (
                    <p className="muted small" style={{ marginBottom: 0 }}>
                      Reducing or waiving requires a reason and is logged with your name. The engagement is
                      stamped so A/R can see how it was set up to pay.
                    </p>
                  ) : null}
                </div>
              ) : null}
            </>
          )}
        </section>
      ) : null}

      <div className="cards">
        {STAGES.map((stage) => {
          const rows = board.filter((r) => r.lead_stage === stage);
          return (
            <section className="card" key={stage}>
              <h2>
                {STAGE_LABEL[stage]} <span className="badge">{stageCount(stage)}</span>
              </h2>
              {rows.length === 0 ? (
                <p className="muted small">Nobody here.</p>
              ) : (
                rows.map((r) => (
                  /* The WHOLE card is the link — a board card with a small link in
                     one corner is a worse target, especially on a phone. Safe to
                     wrap because nothing inside it is interactive. */
                  <Link
                    key={r.id}
                    href={`/clients/${r.id}`}
                    className="lead-card lead-card-link"
                    title={`Open ${r.first_name} ${r.last_name}`}
                  >
                    <strong>
                      {r.first_name} {r.last_name}
                    </strong>{' '}
                    {r.is_test ? (
                      <span className="badge warn" title="Test client: workable here, excluded from every number on this page.">
                        TEST
                      </span>
                    ) : null}
                    <br />
                    <span className="muted small" style={{ overflowWrap: 'anywhere' }}>
                      {r.email ?? 'no email'}
                    </span>
                    <br />
                    <span className="small">
                      {r.quote_status ? (
                        <>
                          <span className={`badge ${r.quote_status === 'accepted' ? 'ok' : r.quote_status === 'sent' ? '' : 'warn'}`}>
                            {r.quote_status}
                          </span>{' '}
                          {r.range_min_cents !== null && r.range_max_cents !== null
                            ? `${money(r.range_min_cents)}–${money(r.range_max_cents)}`
                            : money(r.total_cents)}
                        </>
                      ) : (
                        <span className="muted">no quote yet</span>
                      )}
                    </span>
                    {r.lost_reason ? (
                      <>
                        <br />
                        <span className="muted small" style={{ overflowWrap: 'anywhere' }}>
                          Reason: {r.lost_reason}
                        </span>
                      </>
                    ) : null}
                    {r.expires_at && r.quote_status === 'sent' ? (
                      <>
                        <br />
                        <span className="muted small">expires {r.expires_at.slice(0, 10)}</span>
                      </>
                    ) : null}
                  </Link>
                ))
              )}
            </section>
          );
        })}
      </div>

      {metrics ? (
        <section className="card span" style={{ marginTop: 12 }}>
          <h2>Conversion</h2>
          <p className="small">
            {metrics.quotesSent} sent · {metrics.quotesAccepted} accepted ({money(metrics.acceptedValueCents)}) ·{' '}
            {metrics.quotesDeclined} declined · {metrics.quotesExpired} expired · {metrics.quotesOpen} still open.
          </p>
          <p className="muted small">
            Win rate counts decided quotes only — open proposals are not losses.
          </p>
          {metrics.lostReasons.length > 0 ? (
            <>
              <h2 style={{ marginTop: 10 }}>Why we lost</h2>
              <table className="dense">
                <tbody>
                  {metrics.lostReasons.map((r) => (
                    <tr key={r.reason}>
                      <td className="title-cell">{r.reason}</td>
                      <td>{r.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : null}
        </section>
      ) : null}
    </>
  );
}
