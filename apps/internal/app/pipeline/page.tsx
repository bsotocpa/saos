'use client';

// Leads pipeline + quote builder (M27).
//
// The builder composes ONLY from the price book in force — the catalog it lists
// is the book, and the API refuses any code that isn't in it. Sending pins the
// version, so a price change tomorrow never re-prices a proposal a client is
// reading today.

import { formatDate, formatDateTime, formatTime } from '../../lib/dates';
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
  /** Per-line deposit from the price book. The quote's deposit is the SUM of these. */
  deposit_cents: number | null;
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

/** The deposit as the API resolves it for a quote — what acceptance will invoice. */
interface ServerDeposit {
  standardCents: number | null;
  chargeCents: number | null;
  treatment: 'standard' | 'reduced' | 'waived' | null;
  reason: string | null;
}

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
  /**
   * THE COVERAGE QUESTION, as a decision rather than an error (2026-09-09).
   *
   * The API refuses to send a quote whose schedules the client has already accepted unless
   * the sender declares whether it ADDS work under the existing agreement or REPLACES it —
   * deliberately not a yes/no override, because the two mean different things downstream and
   * the answer is recorded on the quote. That design is right.
   *
   * What was wrong: the refusal came back as text — "Send again with intent additional_work" —
   * and this screen had no way to do that. Brian hit it three times in two minutes on
   * Rehearsal Client 2, and each attempt also created a draft quote the builder then lost
   * track of. An instruction the screen cannot follow is not an error message; it is a dead end
   * wearing one.
   *
   * So a 409 `schedule_already_covered` lands HERE, holding the quote it refused, and renders
   * as the two choices the API is actually asking for.
   */
  const [coverageBlock, setCoverageBlock] = useState<{ quoteId: string; message: string } | null>(null);
  /*
   * ONE ACTIVE ENGAGEMENT PER LINE AND PERIOD (2026-09-09). A 409 change_order_required lands
   * here with the engagements the quote could replace, and renders one button each.
   */
  const [changeOrderBlock, setChangeOrderBlock] = useState<{
    quoteId: string; message: string;
    engagements: Array<{ id: string; title: string | null; serviceLine: string; periodKey: string }>;
  } | null>(null);

  // Builder state
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [matches, setMatches] = useState<Contact[]>([]);
  const [contact, setContact] = useState<Contact | null>(null);
  const [language, setLanguage] = useState<'en' | 'es'>('en');
  const [bundleSlug, setBundleSlug] = useState('');
  const [picked, setPicked] = useState<Array<{ itemCode: string; quantity: number; isOptional: boolean }>>([]);
  const [itemFilter, setItemFilter] = useState('');
  // `depositItemCode` state used to live here — the one-deposit-item model retired in price
  // book v4. Deposits are per line now and the quote's deposit is their sum; see pickedDepositCents.
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
    { url: string; name: string; totalCents: number | null; depositLabel: string } | null
  >(null);
  /** Open (sent, undecided) quotes for the selected client — the duplicate guard. */
  const [openQuotes, setOpenQuotes] = useState<
    Array<{ id: string; status: string; total_cents: number; created_at: string }>
  >([]);
  const [dupAcknowledged, setDupAcknowledged] = useState(false);
  // A saved draft awaiting a deliberate deposit decision, then sending.
  const [draftQuoteId, setDraftQuoteId] = useState('');
  /**
   * The deposit on the saved draft AS THE SERVER RESOLVES IT — re-read after every attempt to
   * change it. Never this panel's memory of what it asked for. 2026-09-09: Brian reduced a
   * deposit here; the prompt-based control failed off-screen and nothing reached the API; the
   * panel kept showing what he had entered; the client was invoiced the standard amount.
   */
  const [draftDeposit, setDraftDeposit] = useState<ServerDeposit | null>(null);
  /** The inline reduce/waive form. Its errors render inside it, next to the button that opened it. */
  const [overrideForm, setOverrideForm] = useState<{ waive: boolean; amount: string; reason: string } | null>(null);
  const [overrideError, setOverrideError] = useState('');
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

  /**
   * THE DEPOSIT THE CLIENT WILL ACTUALLY BE ASKED FOR — a mirror of the server's
   * `summedLineDeposits`, computed here so the builder shows the same number acceptance will
   * charge. Mirrored EXACTLY, including the two things worth knowing about it: it is not
   * quantity-weighted, and it counts optional lines whether or not the client ticks them.
   * Showing a "corrected" figure here would just be a new lie in the other direction; the
   * server is the place to change the rule, and the builder must agree with it.
   *
   * `null` means no chosen line carries a deposit — which is different from a deposit of zero.
   */
  const pickedDepositCents = useMemo(() => {
    const perLine = picked
      .map((p) => catalog.find((i) => i.item_code === p.itemCode)?.deposit_cents ?? null)
      .filter((d): d is number => d !== null);
    return perLine.length === 0 ? null : perLine.reduce((a, b) => a + b, 0);
  }, [picked, catalog]);
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
  /** Re-read the draft's deposit from the server — the only thing this panel displays about it. */
  const refreshDraftDeposit = async (quoteId: string) => {
    try {
      const r = await api<{ deposit: ServerDeposit | null }>(`/quotes/${quoteId}`);
      setDraftDeposit(r.deposit);
    } catch (err) {
      setOverrideError((err as Error).message);
    }
  };

  /** "deposit <amount>" / "deposit waived" / "no deposit" — the words the send button and the sent modal use. */
  const depositWords = (d: ServerDeposit | null | undefined, fallbackCents: number | null) => {
    if (!d) return fallbackCents === null ? 'no deposit' : `deposit ${money(fallbackCents)}`;
    if (d.chargeCents === null) return 'no deposit';
    if (d.chargeCents === 0) return 'deposit waived';
    return d.treatment === 'reduced'
      ? `deposit ${money(d.chargeCents)} (reduced from ${money(d.standardCents)})`
      : `deposit ${money(d.chargeCents)}`;
  };

  /** The deposit as the server holds it at the moment of sending — for the confirmation the sender reads. */
  const depositWordsFor = async (quoteId: string, fallbackCents: number | null) => {
    try {
      const r = await api<{ deposit: ServerDeposit | null }>(`/quotes/${quoteId}`);
      return depositWords(r.deposit, fallbackCents);
    } catch {
      return depositWords(null, fallbackCents);
    }
  };

  const applyOverride = async () => {
    if (!overrideForm || !draftQuoteId) return;
    setOverrideError('');
    let amountCents = 0;
    if (!overrideForm.waive) {
      const parsed = Number(overrideForm.amount.replace(/[^0-9.]/g, ''));
      if (overrideForm.amount.trim() === '' || !Number.isFinite(parsed) || parsed < 0) {
        setOverrideError('Enter a dollar amount of 0 or more.');
        return;
      }
      amountCents = Math.round(parsed * 100);
    }
    if (overrideForm.reason.trim().length < 10) {
      setOverrideError('The reason is the record — please write at least a few words (10+ characters).');
      return;
    }
    setBusy(true);
    try {
      await api<{ treatment: string }>(`/quotes/${draftQuoteId}/deposit-override`, {
        method: 'POST',
        body: { amountCents, reason: overrideForm.reason.trim() },
      });
      setOverrideForm(null);
    } catch (err) {
      setOverrideError((err as Error).message);
    } finally {
      // Whatever happened, show what the server now holds — success and failure both read true.
      await refreshDraftDeposit(draftQuoteId);
      setBusy(false);
    }
  };

  const resetBuilder = () => {
    setContact(null); setSearch(''); setBundleSlug(''); setPicked([]);
    setNotes(''); setSentLink(''); setItemFilter('');
    setDraftQuoteId(''); setDraftDeposit(null); setOverrideForm(null); setOverrideError('');
  };

  /**
   * A refused send is EITHER the coverage question or an ordinary error, and they must not
   * share a banner: one has two correct answers and the other has none. `api()` attaches the
   * API's error code to the thrown Error, which is what makes the split possible.
   */
  const routeSendFailure = (err: unknown, quoteId: string) => {
    const e = err as Error & { code?: string };
    if (e.code === 'change_order_required') {
      const issues = (e as { payload?: { issues?: Array<{ id: string; title: string | null; serviceLine: string; periodKey: string }> } }).payload?.issues ?? [];
      setChangeOrderBlock({ quoteId, message: e.message, engagements: issues });
      setDraftQuoteId(quoteId);
      void refreshDraftDeposit(quoteId);
    } else if (e.code === 'schedule_already_covered') {
      setCoverageBlock({ quoteId, message: e.message });
      // The refused quote is a real draft. Keep hold of it so the decision below — or a later
      // "send draft" — acts on THIS quote instead of leaving it orphaned in the pipeline.
      setDraftQuoteId(quoteId);
      void refreshDraftDeposit(quoteId);
    } else {
      setError(e.message);
    }
  };

  const sendDraft = async () => {
    if (!draftQuoteId) return;
    setBusy(true);
    setError('');
    setCoverageBlock(null);
    try {
      const words = await depositWordsFor(draftQuoteId, pickedDepositCents);
      const r = await api<{ url: string }>(`/quotes/${draftQuoteId}/send`, { method: 'POST' });
      setSentLink(r.url);
      setSentConfirm({
        url: r.url,
        name: contact ? `${contact.first_name} ${contact.last_name}` : 'the client',
        totalCents: null,
        depositLabel: words,
      });
      setOpen(false);
      resetBuilder();
      await load();
    } catch (err) {
      routeSendFailure(err, draftQuoteId);
    } finally {
      setBusy(false);
    }
  };

  /** Answer the coverage question. The intent goes on the quote; the API records it. */
  const sendWithIntent = async (duplicateIntent: 'additional_work' | 'replaces_existing') => {
    if (!coverageBlock || !contact) return;
    setBusy(true);
    setError('');
    try {
      const words = await depositWordsFor(coverageBlock.quoteId, pickedDepositCents);
      const r = await api<{ url: string }>(`/quotes/${coverageBlock.quoteId}/send`, {
        method: 'POST',
        body: { duplicateIntent },
      });
      setCoverageBlock(null);
      setSentLink(r.url);
      setSentConfirm({ url: r.url, name: `${contact.first_name} ${contact.last_name}`, totalCents: null, depositLabel: words });
      setOpen(false);
      resetBuilder();
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const sendChangeOrder = async (engagementId: string) => {
    if (!changeOrderBlock || !contact) return;
    setBusy(true);
    setError('');
    try {
      const words = await depositWordsFor(changeOrderBlock.quoteId, pickedDepositCents);
      const r = await api<{ url: string }>(`/quotes/${changeOrderBlock.quoteId}/send`, {
        method: 'POST',
        body: { changeOrderOf: engagementId },
      });
      setChangeOrderBlock(null);
      setSentLink(r.url);
      setSentConfirm({ url: r.url, name: `${contact.first_name} ${contact.last_name}`, totalCents: null, depositLabel: words });
      setOpen(false);
      resetBuilder();
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
    setCoverageBlock(null);
    setChangeOrderBlock(null);
    // Hoisted out of the try: the quote is CREATED before the send can be refused, and the
    // catch needs its id to keep it as the draft instead of losing it. Three orphaned drafts
    // in two minutes is how this line earned its place.
    let createdId = '';
    try {
      const created = await api<{ id: string }>('/quotes', {
        method: 'POST',
        body: {
          contactId: contact.id,
          language,
          ...(bundleSlug ? { bundleSlug } : { lines: picked }),
          ...(bundleSlug ? { includeOptional: picked.filter((p) => p.isOptional).map((p) => p.itemCode) } : {}),
          asRange,
          expiresInDays,
          ...(notes.trim() ? { notes: notes.trim() } : {}),
        },
      });
      createdId = created.id;
      if (send) {
        const words = await depositWordsFor(created.id, pickedDepositCents);
        const r = await api<{ url: string }>(`/quotes/${created.id}/send`, { method: 'POST' });
        setSentLink(r.url);
        setSentConfirm({
          url: r.url,
          name: `${contact.first_name} ${contact.last_name}`,
          totalCents: null,
          depositLabel: words,
        });
        setOpen(false);
        resetBuilder();
      } else {
        // Saving a draft keeps the composer open so the deposit can be adjusted
        // deliberately before the client ever sees the quote.
        setDraftQuoteId(created.id);
        await refreshDraftDeposit(created.id);
      }
      await load();
    } catch (err) {
      // Once the quote exists, a refusal is about THAT quote — hand it over rather than dropping
      // it. Before it exists there is nothing to hand over and the error is just an error.
      if (createdId) routeSendFailure(err, createdId);
      else setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const stageCount = (stage: string) => metrics?.byStage.find((s) => s.stage === stage)?.count ?? 0;

  return (
    <>
      <h1>Pipeline</h1>
      {error ? <div className="alert error">{error}</div> : null}

      {/* The coverage QUESTION — the API's two answers, as two buttons. The first sentence of
          the API's message names the schedule, which is the useful part; the rest was an
          instruction this screen could not follow, so it is replaced by the controls that can. */}
      {changeOrderBlock ? (
        <div className="alert warn">
          <p>
            <strong>This client already has active work on this line for this period.</strong>{' '}
            A second agreement for the same work is a change order: it replaces the engagement you
            name, carries any unapplied deposit credit across, and is recorded as a supersession.
          </p>
          <p>
            {changeOrderBlock.engagements.map((e) => (
              <span key={e.id}>
                <button type="button" className="btn" disabled={busy} onClick={() => void sendChangeOrder(e.id)}>
                  Change order replacing “{e.title ?? e.serviceLine}” ({e.periodKey})
                </button>{' '}
              </span>
            ))}
            <button type="button" className="btn ghost small" disabled={busy} onClick={() => setChangeOrderBlock(null)}>
              Not now — keep it as a draft
            </button>
          </p>
        </div>
      ) : null}
      {coverageBlock ? (
        <div className="alert warn">
          <p>
            <strong>{coverageBlock.message.split('. ')[0]}.</strong>{' '}
            Is this quote adding work under that agreement, or replacing it? Your answer is recorded
            on the quote, so it can be read back later with the reason that justified it.
          </p>
          <p>
            <button type="button" className="btn" disabled={busy} onClick={() => void sendWithIntent('additional_work')}>
              Adds to the existing agreement
            </button>{' '}
            <button type="button" className="btn ghost" disabled={busy} onClick={() => void sendWithIntent('replaces_existing')}>
              Replaces the existing agreement
            </button>{' '}
            <button type="button" className="btn ghost small" disabled={busy} onClick={() => setCoverageBlock(null)}>
              Not now — keep it as a draft
            </button>
          </p>
        </div>
      ) : null}

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
            <p>
              <strong>{sentConfirm.depositLabel.charAt(0).toUpperCase() + sentConfirm.depositLabel.slice(1)}</strong>
              {' '}— this is what the proposal shows and what acceptance will invoice.
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
                  {money(q.total_cents)} · sent {formatDate(q.created_at)} · awaiting their decision
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
                {/* Read-only on purpose: the deposit is a property of the lines, not a choice
                    made here. This replaces a dropdown from the retired one-deposit-item model
                    that read "— no deposit —" over a quote carrying a real deposit. If the figure is
                    wrong, the place to change it is the price book, and the place to reduce or
                    waive it for one client is the deposit override after saving a draft. */}
                <div className="field">
                  Deposit the client will be asked for
                  <p className="muted small">
                    {pickedDepositCents === null
                      ? 'None — no chosen line carries a deposit in the price book in force.'
                      : `${money(pickedDepositCents)} — summed from the lines' price-book deposits, exactly as the client will see it on the proposal.`}
                  </p>
                </div>
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
                  {/* What the SERVER will invoice — re-read after every change, never this panel's memory. */}
                  {draftDeposit === null ? (
                    <>Reading the deposit…</>
                  ) : draftDeposit.chargeCents === null ? (
                    <>No deposit on this quote — none of its lines carry one.</>
                  ) : draftDeposit.treatment === 'waived' ? (
                    <>
                      Deposit is <strong>WAIVED</strong> (standard {money(draftDeposit.standardCents)})
                      {draftDeposit.reason ? <> — “{draftDeposit.reason}”</> : null}. Recorded against the engagement for A/R.
                    </>
                  ) : draftDeposit.treatment === 'reduced' ? (
                    <>
                      Deposit is <strong>{money(draftDeposit.chargeCents)}</strong>, reduced from {money(draftDeposit.standardCents)}
                      {draftDeposit.reason ? <> — “{draftDeposit.reason}”</> : null}. Recorded against the engagement for A/R.
                    </>
                  ) : (
                    <>
                      Deposit the client will be asked for: <strong>{money(draftDeposit.chargeCents)}</strong> (standard).
                    </>
                  )}
                  {overrideForm ? (
                    <div className="alert warn" style={{ marginTop: 8, marginBottom: 0 }}>
                      <strong>{overrideForm.waive ? 'Waive the deposit' : 'Reduce the deposit'}</strong>
                      {!overrideForm.waive ? (
                        <label className="field" style={{ marginTop: 6 }}>
                          New deposit, in dollars (standard is {money(draftDeposit?.standardCents ?? null)}; 0 waives it)
                          <input
                            type="text"
                            inputMode="decimal"
                            value={overrideForm.amount}
                            onChange={(e) => setOverrideForm({ ...overrideForm, amount: e.target.value })}
                          />
                        </label>
                      ) : null}
                      <label className="field" style={{ marginTop: 6 }}>
                        Why? Recorded against the engagement with your name (at least 10 characters)
                        <textarea
                          rows={2}
                          value={overrideForm.reason}
                          onChange={(e) => setOverrideForm({ ...overrideForm, reason: e.target.value })}
                        />
                      </label>
                      {overrideError ? <div className="alert error" style={{ marginBottom: 6 }}>{overrideError}</div> : null}
                      <div className="chipbar" style={{ marginBottom: 0 }}>
                        <button type="button" className="btn accent" disabled={busy} onClick={() => void applyOverride()}>
                          {overrideForm.waive ? 'Waive deposit' : 'Apply reduced deposit'}
                        </button>
                        <button
                          type="button"
                          className="btn ghost"
                          disabled={busy}
                          onClick={() => { setOverrideForm(null); setOverrideError(''); }}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : null /* the override error renders inside the panel only */}
                  <div className="chipbar" style={{ marginTop: 8, marginBottom: 0 }}>
                    <button
                      type="button"
                      className="btn accent"
                      disabled={busy || draftDeposit === null}
                      onClick={() => void sendDraft()}
                    >
                      Send to client — {depositWords(draftDeposit, pickedDepositCents)}
                    </button>
                    {canOverrideDeposit && draftDeposit && draftDeposit.standardCents !== null && !overrideForm ? (
                      <>
                        <button
                          type="button"
                          className="chip"
                          disabled={busy}
                          onClick={() => { setOverrideError(''); setOverrideForm({ waive: false, amount: '', reason: '' }); }}
                        >
                          Reduce deposit…
                        </button>
                        <button
                          type="button"
                          className="chip"
                          disabled={busy}
                          onClick={() => { setOverrideError(''); setOverrideForm({ waive: true, amount: '0', reason: '' }); }}
                        >
                          Waive deposit…
                        </button>
                      </>
                    ) : null}
                  </div>
                  {canOverrideDeposit && draftDeposit && draftDeposit.standardCents !== null ? (
                    <p className="muted small" style={{ marginBottom: 0 }}>
                      Reducing or waiving requires a reason and is logged with your name. The figure on the send
                      button is what the client will be asked for — read back from the server after every change.
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
                        <span className="muted small">expires {formatDate(r.expires_at)}</span>
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
