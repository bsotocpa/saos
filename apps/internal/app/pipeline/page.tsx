'use client';

// Leads pipeline + quote builder (M27).
//
// The builder composes ONLY from the price book in force — the catalog it lists
// is the book, and the API refuses any code that isn't in it. Sending pins the
// version, so a price change tomorrow never re-prices a proposal a client is
// reading today.

import { ModalShell } from '../../components/modal-shell';
import { dayOf, formatDate, formatDateTime, formatTime } from '../../lib/dates';
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api, isAuthed } from '../../lib/api';
import {
  addCustomLine, addLine, bookPrice, builderSummary, isOffBook, isPicked, lineTotals, matchesFilter, orderGroups,
  packageDiscountCents, parseDollars, quotedRange, showsQuantity, taxYearLabel, taxYearOptions, unitWords,
  type CatalogGroup, type ClientType, type PickedLine, type TaxYearSource,
} from './builder-lib';
import { BuilderV1Composer } from './builder-v1';

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
  /** Presentation (2026-09-20): the one-line description, the catalog group and the position in it. */
  description_en: string | null;
  group_key: string | null;
  sort_order: number;
}
interface CatalogBundle { slug: string; name_en: string; component_count: number }
/** What GET /bundles/:slug composes: the lines a package fills the quote with, and its discount rule. */
interface ComposedPackage {
  lines: Array<{ itemCode: string; quantity: number; isOptional: boolean }>;
  discount: { kind: 'percent' | 'fixed' | 'override' | 'none'; value: number | null; amountCents: number };
}
interface Contact { id: string; first_name: string; last_name: string; email: string | null }
interface ContactBusiness { id: string; name: string; is_primary: boolean; status?: string | null; entity_type?: string | null; unverified_import_source?: string | null }
/** Lines that are business work (mirrors BUSINESS_LINES in pricing/quotes.ts; the API is the gate). */
const BUSINESS_LINES = new Set(['business_tax', 'recurring_accounting', 'attest', 'setup_conversion', 'entity_services', 'software_passthrough', 'coo']);

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
  /** Decision 2 (2026-09-09): the tax year a return quoted today is for — from the server. */
  const [defaultTaxYear, setDefaultTaxYear] = useState<number | null>(null);
  /** Item 13c: the year on the quote — the default until changed; the interview's when it said so. */
  const [taxYear, setTaxYear] = useState<number | null>(null);
  const [taxYearSource, setTaxYearSource] = useState<TaxYearSource>('default');
  const [bundles, setBundles] = useState<CatalogBundle[]>([]);
  /** The load result only: a refused send renders beside the button that sent (Brian, 2026-09-19, defect 2). */
  const [error, setError] = useState('');
  const [inlineErr, setInlineErr] = useState<{ key: string; message: string } | null>(null);
  const errAt = (key: string) => (inlineErr?.key === key ? <p className="field-error" role="alert">{inlineErr.message}</p> : null);
  const refused = (err: unknown) => (err instanceof Error && err.message ? err.message : 'The request was refused.');
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
  /*
   * A BUSINESS LINE NAMES ITS BUSINESS (2026-09-12, Brian). The builder asks for it here, with
   * the client in front of the person; when the contact has no primary business, this choice
   * becomes it. The API refuses a business line without one, so this is the honest control, not
   * the only guard.
   */
  const [businesses, setBusinesses] = useState<ContactBusiness[]>([]);
  const [businessId, setBusinessId] = useState('');
  const [language, setLanguage] = useState<'en' | 'es'>('en');
  const [bundleSlug, setBundleSlug] = useState('');
  const [picked, setPicked] = useState<PickedLine[]>([]);
  const [itemFilter, setItemFilter] = useState('');
  /*
   * THE REDESIGNED BUILDER (Brian, 2026-09-20): grouped catalog rows beside "This quote". The
   * groups, the custom-line service lines and the range band all come from the catalog response;
   * the screen carries no copy of any of them.
   */
  const [groups, setGroups] = useState<CatalogGroup[]>([]);
  const [serviceLines, setServiceLines] = useState<Array<{ key: string; label: string }>>([]);
  const [bandPercent, setBandPercent] = useState(0);
  /** Which client type's groups lead the catalog. Follows the business select until the person flips it. */
  const [clientType, setClientType] = useState<ClientType>('business');
  const [clientTypeChosen, setClientTypeChosen] = useState(false);
  /** Groups the person collapsed; every group starts open, and a filter opens every group it matches. */
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  /** The amount box on each line as typed, keyed by item code; the parsed cents live on the line itself. */
  const [amountText, setAmountText] = useState<Record<string, string>>({});
  /** One reason for every line priced off the book; the field exists only while one is. */
  const [priceChangeReason, setPriceChangeReason] = useState('');
  const [customForm, setCustomForm] = useState<{ name: string; amount: string; serviceLine: string } | null>(null);
  const [customError, setCustomError] = useState('');
  /** The package's discount rule, mirrored from the compose response so the totals show it live. */
  const [packageRule, setPackageRule] = useState<ComposedPackage['discount'] | null>(null);
  const [canSavePackage, setCanSavePackage] = useState(false);
  /** OPS_QUOTE_BUILDER: v1 is the chip builder production runs; v2 the redesign, shown only when the server says so. */
  const [builderVersion, setBuilderVersion] = useState<'v1' | 'v2'>('v1');
  const [packageForm, setPackageForm] = useState<{ name: string } | null>(null);
  const [packageSaved, setPackageSaved] = useState<{ slug: string; name: string } | null>(null);
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
        api<{
          items: CatalogItem[]; bundles: CatalogBundle[]; defaultTaxYear: number | null;
          groups?: CatalogGroup[]; serviceLines?: Array<{ key: string; label: string }>; bandPercent?: number;
        }>('/quotes/catalog'),
      ]);
      setBoard(p.board);
      setMetrics(p.metrics);
      setCatalog(c.items);
      setDefaultTaxYear(c.defaultTaxYear ?? null);
      setTaxYear(c.defaultTaxYear ?? null);
      setTaxYearSource('default');
      setBundles(c.bundles);
      setGroups(c.groups ?? []);
      setServiceLines(c.serviceLines ?? []);
      setBandPercent(c.bandPercent ?? 0);
      // `deposits.override` and `pricing.packages.save` are explicit-only, so a '*' role does NOT
      // imply them — check for the key itself, exactly as the API does.
      const me = await api<{ permissions: string[]; switches?: { quoteBuilder?: 'v1' | 'v2' } }>('/auth/me');
      setCanOverrideDeposit(me.permissions.includes('deposits.override'));
      setCanSavePackage(me.permissions.includes('pricing.packages.save'));
      // OPS_QUOTE_BUILDER (2026-09-20): the server's switch, default v1; only an explicit v2 shows the redesign.
      setBuilderVersion(me.switches?.quoteBuilder === 'v2' ? 'v2' : 'v1');
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
  useEffect(() => {
    setBusinessId('');
    if (!contact) { setBusinesses([]); return; }
    void api<{ businesses: ContactBusiness[] }>(`/contacts/${contact.id}`)
      .then((r) => setBusinesses(r.businesses ?? []))
      .catch(() => setBusinesses([]));
  }, [contact]);

  /** The groups follow the business select — business work leads when a business is chosen — until the person flips them. */
  useEffect(() => {
    if (!clientTypeChosen) setClientType(businessId ? 'business' : 'individual');
  }, [businessId, clientTypeChosen]);

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
  /** The catalog as grouped rows: the groups fitting the client type first, the filter applied inside each. */
  const groupedCatalog = useMemo(() => {
    const ordered = orderGroups(groups, clientType);
    const known = new Set(ordered.map((g) => g.key));
    // A row whose group the API did not name still renders, at the end, so nothing in the book is unreachable.
    const withUnknown = catalog.some((i) => !i.group_key || !known.has(i.group_key))
      ? [...ordered, { key: '__other', label: 'Other', fits: 'both' as const }]
      : ordered;
    return withUnknown
      .map((g) => ({
        group: g,
        rows: catalog
          .filter((i) => i.service_line !== 'deposit')
          .filter((i) => (g.key === '__other' ? !i.group_key || !known.has(i.group_key) : i.group_key === g.key))
          .filter((i) => matchesFilter(i, g.label, itemFilter))
          .sort((a, b) => a.sort_order - b.sort_order || a.item_code.localeCompare(b.item_code)),
      }))
      .filter((g) => g.rows.length > 0);
  }, [catalog, groups, clientType, itemFilter]);
  const summary = useMemo(() => builderSummary(picked, catalog), [picked, catalog]);
  const discountCents = packageRule ? packageDiscountCents(packageRule, summary.committedCents) : 0;
  const quotedTotalCents = Math.max(0, summary.committedCents - discountCents);
  const range = quotedRange(quotedTotalCents, bandPercent, asRange);
  const unconfirmed = picked.filter((p) => catalog.find((i) => i.item_code === p.itemCode)?.needs_confirmation);
  const itemOf = (code: string) => catalog.find((i) => i.item_code === code);
  const lineName = (p: PickedLine) => p.custom?.name ?? itemOf(p.itemCode)?.name_en ?? p.itemCode;
  /** The book's amount, its range, or a dash for a line with no book price. */
  const bookWords = (item: CatalogItem | undefined) => {
    const b = bookPrice(item);
    if (b.kind === 'amount') return money(b.cents);
    if (b.kind === 'range') return `${money(b.min)}–${money(b.max)}`;
    return '—';
  };
  const dollarsOf = (cents: number | null) => (cents === null ? '' : (cents / 100).toFixed(2));

  /** "Add" on a row: the line joins once at the book price, its amount box pre-filled from the book. */
  const addItem = (code: string) => {
    const item = itemOf(code);
    setPicked((prev) => addLine(prev, code));
    setAmountText((prev) => (code in prev ? prev : { ...prev, [code]: dollarsOf(item?.amount_cents ?? null) }));
  };
  const removeLine = (code: string) => {
    setPicked((prev) => prev.filter((p) => p.itemCode !== code));
    setAmountText((prev) => { const next = { ...prev }; delete next[code]; return next; });
  };
  /** The amount box: the text stays as typed; the line's cents follow it (blank puts the book price back). */
  const setAmount = (code: string, text: string) => {
    setAmountText((prev) => ({ ...prev, [code]: text }));
    const cents = parseDollars(text);
    setPicked((prev) => prev.map((p) => (p.itemCode === code ? { ...p, unitCents: p.custom ? (cents ?? p.unitCents ?? 0) : cents } : p)));
  };
  const addCustom = () => {
    if (!customForm) return;
    const cents = parseDollars(customForm.amount);
    if (customForm.name.trim().length === 0) { setCustomError('Name the line.'); return; }
    if (cents === null) { setCustomError('Enter a dollar amount of 0 or more.'); return; }
    if (!customForm.serviceLine) { setCustomError('Choose the service line this belongs to.'); return; }
    const next = addCustomLine(picked, { name: customForm.name.trim(), serviceLine: customForm.serviceLine, unitCents: cents });
    const added = next[next.length - 1]!;
    setPicked(next);
    setAmountText((prev) => ({ ...prev, [added.itemCode]: dollarsOf(cents) }));
    setCustomForm(null);
    setCustomError('');
  };
  /** Choosing a package fills the lines from the book; every line stays editable from there. */
  const applyPackage = async (slug: string) => {
    setInlineErr((e) => (e?.key === 'package' ? null : e));
    setBundleSlug(slug);
    if (!slug) { setPackageRule(null); return; }
    try {
      const composed = await api<ComposedPackage>(`/bundles/${encodeURIComponent(slug)}`);
      const lines: PickedLine[] = composed.lines.map((l) => ({ itemCode: l.itemCode, quantity: Number(l.quantity) || 1, isOptional: l.isOptional, unitCents: null }));
      setPicked(lines);
      setAmountText(Object.fromEntries(lines.map((l) => [l.itemCode, dollarsOf(itemOf(l.itemCode)?.amount_cents ?? null)])));
      setPackageRule(composed.discount);
    } catch (err) {
      setBundleSlug('');
      setPackageRule(null);
      setInlineErr({ key: 'package', message: refused(err) });
    }
  };
  const savePackage = async () => {
    if (!packageForm) return;
    setInlineErr((e) => (e?.key === 'savePackage' ? null : e));
    setBusy(true);
    try {
      const r = await api<{ slug: string; name: string }>('/quotes/packages', {
        method: 'POST',
        body: { name: packageForm.name, lines: picked.filter((p) => !p.custom).map((p) => ({ itemCode: p.itemCode, quantity: p.quantity, isOptional: p.isOptional })) },
      });
      setPackageSaved(r);
      setPackageForm(null);
      const c = await api<{ bundles: CatalogBundle[] }>('/quotes/catalog');
      setBundles(c.bundles);
    } catch (err) {
      setInlineErr({ key: 'savePackage', message: refused(err) });
    } finally {
      setBusy(false);
    }
  };
  /** The lines as the API takes them: a book code or a custom line, the amount only when the person set one. */
  const linesPayload = () => picked.map((p) => ({
    ...(p.custom ? { custom: { name: p.custom.name, serviceLine: p.custom.serviceLine } } : { itemCode: p.itemCode }),
    quantity: p.quantity,
    isOptional: p.isOptional,
    ...(p.unitCents !== null && p.unitCents !== undefined ? { unitCents: p.unitCents } : {}),
  }));
  /**
   * A refusal lands at the control it names (2026-09-19): the server's issue path picks the key —
   * the reason field, the line, or the button — and the message is the server's own.
   */
  const inlineKeyFor = (err: unknown): { key: string; message: string } => {
    const e = err as Error & { payload?: { issues?: Array<{ path?: string; message?: string }> } };
    const issues = e.payload?.issues ?? [];
    const reasonIssue = issues.find((i) => i.path === 'priceChangeReason');
    if (reasonIssue?.message) return { key: 'reason', message: reasonIssue.message };
    const lineIssue = issues.find((i) => /^lines\.\d+/.test(i.path ?? ''));
    if (lineIssue?.message) {
      const n = Number(/^lines\.(\d+)/.exec(lineIssue.path ?? '')?.[1] ?? -1);
      const code = picked[n]?.itemCode;
      return { key: code ? `line-${code}` : 'build', message: lineIssue.message };
    }
    return { key: 'build', message: refused(err) };
  };

  /**
   * Deposit override. Deliberately NOT an inline editable field on the builder:
   * the standard deposit is what happens unless someone chooses otherwise, and
   * that choice needs a confirm step and a reason. Only visible to staff who hold
   * `deposits.override` — and the API refuses it regardless of what the UI shows.
   */
  /** Re-read the draft's deposit from the server — the only thing this panel displays about it. */
  const refreshDraftDeposit = async (quoteId: string) => {
    setInlineErr((e) => (e?.key === 'deposit' ? null : e));
    try {
      const r = await api<{ deposit: ServerDeposit | null }>(`/quotes/${quoteId}`);
      setDraftDeposit(r.deposit);
    } catch (err) {
      // Beside the deposit line in the draft panel, whether or not the override panel is open.
      setInlineErr({ key: 'deposit', message: refused(err) });
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
    setContact(null); setSearch(''); setBundleSlug(''); setPicked([]); setBusinessId('');
    setNotes(''); setSentLink(''); setItemFilter('');
    setDraftQuoteId(''); setDraftDeposit(null); setOverrideForm(null); setOverrideError(''); setInlineErr(null);
    setAmountText({}); setPriceChangeReason(''); setCustomForm(null); setCustomError('');
    setPackageRule(null); setPackageForm(null); setPackageSaved(null); setClientTypeChosen(false);
  };

  /**
   * A refused send is EITHER the coverage question or an ordinary error, and they must not
   * share a banner: one has two correct answers and the other has none. `api()` attaches the
   * API's error code to the thrown Error, which is what makes the split possible. An ordinary
   * error renders beside the button named by `key`.
   */
  const routeSendFailure = (err: unknown, quoteId: string, key: string) => {
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
      setInlineErr({ key, message: refused(e) });
    }
  };

  const sendDraft = async () => {
    if (!draftQuoteId) return;
    setBusy(true);
    setInlineErr(null);
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
      routeSendFailure(err, draftQuoteId, 'sendDraft');
    } finally {
      setBusy(false);
    }
  };

  /** Answer the coverage question. The intent goes on the quote; the API records it. */
  const sendWithIntent = async (duplicateIntent: 'additional_work' | 'replaces_existing') => {
    if (!coverageBlock || !contact) return;
    setBusy(true);
    setInlineErr(null);
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
      setInlineErr({ key: 'intent', message: refused(err) });
    } finally {
      setBusy(false);
    }
  };

  const sendChangeOrder = async (engagementId: string) => {
    if (!changeOrderBlock || !contact) return;
    setBusy(true);
    setInlineErr(null);
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
      setInlineErr({ key: 'changeOrder', message: refused(err) });
    } finally {
      setBusy(false);
    }
  };

  const buildAndSend = async (send: boolean) => {
    if (!contact) return;
    setBusy(true);
    setInlineErr(null);
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
          ...(businessId ? { businessId } : {}),
          language,
          // v2: the lines as they stand on the screen, package or not — a package filled them and the
          // API applies its discount rule to what they now come to. v1: the pre-redesign shape,
          // a package by slug (with the ticked optional components) or the picked codes.
          ...(builderVersion === 'v2'
            ? {
                lines: linesPayload(),
                ...(bundleSlug ? { bundleSlug } : {}),
                ...(summary.offBook.length > 0 ? { priceChangeReason: priceChangeReason.trim() } : {}),
              }
            : {
                ...(bundleSlug ? { bundleSlug } : { lines: picked.map((p) => ({ itemCode: p.itemCode, quantity: p.quantity, isOptional: p.isOptional })) }),
                ...(bundleSlug ? { includeOptional: picked.filter((p) => p.isOptional).map((p) => p.itemCode) } : {}),
              }),
          asRange,
          expiresInDays,
          ...(notes.trim() ? { notes: notes.trim() } : {}),
          // Item 13c: the year the person saw, and whether it was the default or their choice.
          ...(taxYear ? { interviewAnswers: { tax_year: taxYear, tax_year_source: taxYearSource } } : {}),
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
      if (createdId) routeSendFailure(err, createdId, 'build');
      else setInlineErr(inlineKeyFor(err));
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
          {errAt('changeOrder')}
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
          {errAt('intent')}
        </div>
      ) : null}

      {/* THE SEND CONFIRMATION. Its own modal, outside the builder, dismissed only
          by an explicit click — the previous version lived inside the composer and
          was wiped by resetBuilder(), so the send left no trace and a second quote
          got built. It stays until Brian says he has seen it. */}
      {sentConfirm ? (
        <ModalShell id="quote-sent" title={`Quote sent to ${sentConfirm.name}`} onClose={() => { setSentConfirm(null); setSentLink(''); }}>
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
        </ModalShell>
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
                  {money(q.total_cents)} · sent {dayOf(q.created_at)} · awaiting their decision
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

              {contact ? (
                <label className="field">
                  Business{picked.some((p) => BUSINESS_LINES.has(p.custom?.serviceLine ?? catalog.find((i) => i.item_code === p.itemCode)?.service_line ?? '')) || bundleSlug ? <span className="muted small"> (required for business work)</span> : <span className="muted small"> (optional)</span>}
                  {businesses.length === 0 ? (
                    <span className="muted small">No business on this record. Add one on the client page before quoting business work.</span>
                  ) : (
                    <select value={businessId} onChange={(e) => setBusinessId(e.target.value)}>
                      <option value="">— none —</option>
                      {businesses.map((b) => (
                        <option key={b.id} value={b.id}>
                          {b.name} · {b.entity_type ? b.entity_type.replaceAll('_', ' ') : 'entity type unknown'}
                          {b.unverified_import_source ? ` · unverified import (${b.unverified_import_source})` : ''}
                          {b.is_primary ? ' · primary' : ''}{b.status === 'dissolved' ? ' · dissolved' : ''}
                        </option>
                      ))}
                    </select>
                  )}
                  {businesses.length > 0 && !businesses.some((b) => b.is_primary) ? (
                    <span className="muted small">No primary business set; the business chosen here becomes it.</span>
                  ) : null}
                </label>
              ) : null}
              {builderVersion !== 'v2' ? (
                /* OPS_QUOTE_BUILDER=v1 (the production default until Brian approves the redesign's
                   screenshots): the chip builder, unchanged, from builder-v1.tsx. */
                <BuilderV1Composer
                  catalog={catalog}
                  bundles={bundles}
                  picked={picked}
                  setPicked={setPicked}
                  bundleSlug={bundleSlug}
                  setBundleSlug={setBundleSlug}
                  language={language}
                  setLanguage={setLanguage}
                  expiresInDays={expiresInDays}
                  setExpiresInDays={setExpiresInDays}
                  asRange={asRange}
                  setAsRange={setAsRange}
                  itemFilter={itemFilter}
                  setItemFilter={setItemFilter}
                  notes={notes}
                  setNotes={setNotes}
                  pickedDepositCents={pickedDepositCents}
                  defaultTaxYear={defaultTaxYear}
                  taxYear={taxYear}
                  taxYearSource={taxYearSource}
                  setTaxYear={setTaxYear}
                  setTaxYearSource={setTaxYearSource}
                  busy={busy}
                  hasContact={Boolean(contact)}
                  buildAndSend={(send) => void buildAndSend(send)}
                  errAt={errAt}
                />
              ) : (
              <>
              <div className="grid2">
                <label className="field">
                  Language
                  <select value={language} onChange={(e) => setLanguage(e.target.value as 'en' | 'es')}>
                    <option value="en">English</option>
                    <option value="es">Español</option>
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

              {/* THE CATALOG BESIDE THE QUOTE (2026-09-20): grouped rows on the left, the editable
                  line table on the right; on a phone the quote sits below the catalog and the fixed
                  footer carries the total. */}
              <div className="qb">
                <div className="qb-catalog">
                  <div className="qb-toolbar">
                    <div className="qb-segment" role="group" aria-label="Quoting for">
                      <button
                        type="button"
                        className={clientType === 'business' ? 'chip active' : 'chip'}
                        aria-pressed={clientType === 'business'}
                        onClick={() => { setClientType('business'); setClientTypeChosen(true); }}
                      >
                        Business
                      </button>
                      <button
                        type="button"
                        className={clientType === 'individual' ? 'chip active' : 'chip'}
                        aria-pressed={clientType === 'individual'}
                        onClick={() => { setClientType('individual'); setClientTypeChosen(true); }}
                      >
                        Individual
                      </button>
                    </div>
                    <label className="field qb-filter">
                      Find a service
                      <input
                        type="search"
                        value={itemFilter}
                        placeholder="Filter by name, form number or group"
                        onChange={(e) => setItemFilter(e.target.value)}
                      />
                    </label>
                    <label className="field qb-package">
                      Package
                      <select value={bundleSlug} onChange={(e) => void applyPackage(e.target.value)}>
                        <option value="">— none —</option>
                        {bundles.map((b) => (
                          <option key={b.slug} value={b.slug}>{b.name_en} ({b.component_count} items)</option>
                        ))}
                      </select>
                    </label>
                  </div>
                  {errAt('package')}
                  {groupedCatalog.length === 0 ? (
                    <p className="muted small">Nothing in the book matches “{itemFilter}”.</p>
                  ) : null}
                  {groupedCatalog.map(({ group, rows }) => (
                    <details
                      key={group.key}
                      className="qb-group"
                      open={itemFilter.trim().length > 0 || !collapsed.has(group.key)}
                      onToggle={(e) => {
                        const isOpen = (e.currentTarget as HTMLDetailsElement).open;
                        setCollapsed((prev) => {
                          const next = new Set(prev);
                          if (isOpen) next.delete(group.key); else next.add(group.key);
                          return next;
                        });
                      }}
                    >
                      <summary>
                        <span>{group.label}</span>
                        <span className="muted small">{rows.length}</span>
                      </summary>
                      {rows.map((i) => {
                        const on = isPicked(picked, i.item_code);
                        return (
                          <div className="qb-row" key={i.item_code}>
                            <div className="qb-row-main">
                              <span className="qb-name">{i.name_en}{i.needs_confirmation ? ' ⚠' : ''}</span>
                              {i.description_en ? <span className="qb-desc muted small">{i.description_en}</span> : null}
                            </div>
                            <span className="qb-price">
                              {bookWords(i)}{unitWords(i.unit) ? <span className="muted small"> {unitWords(i.unit)}</span> : null}
                            </span>
                            <button
                              type="button"
                              className={on ? 'btn ghost small qb-add' : 'btn small qb-add'}
                              disabled={on}
                              aria-label={`${on ? 'Added' : 'Add'} ${i.name_en}`}
                              onClick={() => addItem(i.item_code)}
                            >
                              {on ? 'Added' : 'Add'}
                            </button>
                          </div>
                        );
                      })}
                    </details>
                  ))}
                  <div className="qb-custom">
                    {customForm ? (
                      <div className="qb-custom-form">
                        <strong className="small">A custom line</strong>
                        <label className="field" style={{ marginTop: 6 }}>
                          Name
                          <input type="text" value={customForm.name} onChange={(e) => setCustomForm({ ...customForm, name: e.target.value })} />
                        </label>
                        <div className="grid2">
                          <label className="field">
                            Amount, in dollars
                            <input type="text" inputMode="decimal" value={customForm.amount} onChange={(e) => setCustomForm({ ...customForm, amount: e.target.value })} />
                          </label>
                          <label className="field">
                            Service line
                            <select value={customForm.serviceLine} onChange={(e) => setCustomForm({ ...customForm, serviceLine: e.target.value })}>
                              <option value="">— choose —</option>
                              {serviceLines.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                            </select>
                          </label>
                        </div>
                        {customError ? <p className="field-error" role="alert">{customError}</p> : null}
                        <div className="chipbar" style={{ marginBottom: 0 }}>
                          <button type="button" className="btn small" onClick={addCustom}>Add line</button>
                          <button type="button" className="btn ghost small" onClick={() => { setCustomForm(null); setCustomError(''); }}>Cancel</button>
                        </div>
                      </div>
                    ) : (
                      <button type="button" className="btn ghost small" onClick={() => setCustomForm({ name: '', amount: '', serviceLine: '' })}>
                        Add a custom line
                      </button>
                    )}
                  </div>
                </div>

                <div className="qb-quote" aria-label="This quote">
                  <h3>This quote</h3>
                  {picked.length === 0 ? (
                    <p className="muted small">No lines yet. Add services from the catalog, or choose a package.</p>
                  ) : (
                    <>
                      {/* 13b: the summary — line count, subtotal, deposit — follows every tap and keystroke. */}
                      <div className="builder-summary" aria-live="polite">
                        <span><strong>{summary.lineCount}</strong> line{summary.lineCount === 1 ? '' : 's'}</span>
                        <span>Subtotal <strong>{money(summary.committedCents)}</strong></span>
                        <span>Deposit <strong>{summary.depositCents === null ? 'none' : money(summary.depositCents)}</strong></span>
                      </div>
                      <table className="qb-lines">
                        <thead>
                          <tr>
                            <th>Line</th>
                            <th>Qty</th>
                            <th className="num">Unit amount</th>
                            <th className="num">Total</th>
                            <th aria-label="Remove" />
                          </tr>
                        </thead>
                        <tbody>
                          {picked.map((p) => {
                            const item = itemOf(p.itemCode);
                            const off = isOffBook(p, item);
                            const t = lineTotals(p, item);
                            const totalWords = t.exactCents !== null
                              ? money(t.exactCents)
                              : t.minCents !== null && t.maxCents !== null ? `${money(t.minCents)}–${money(t.maxCents)}` : '—';
                            const name = lineName(p);
                            return (
                              <tr key={p.itemCode} className={off ? 'off-book' : undefined}>
                                <td className="line-name">
                                  <strong>{name}</strong>
                                  {p.custom ? <span className="badge" style={{ marginLeft: 6 }}>custom</span> : null}
                                  {item?.needs_confirmation ? ' ⚠' : ''}
                                  {unitWords(item?.unit) ? <span className="qb-book">{unitWords(item?.unit)}</span> : null}
                                  <label className="inline-check small" style={{ marginTop: 4, fontWeight: 500 }}>
                                    <input
                                      type="checkbox"
                                      checked={p.isOptional}
                                      onChange={(e) => setPicked((prev) => prev.map((x) => (x.itemCode === p.itemCode ? { ...x, isOptional: e.target.checked } : x)))}
                                    />
                                    <span>Optional — the client&apos;s choice</span>
                                  </label>
                                  {errAt(`line-${p.itemCode}`)}
                                </td>
                                <td className="qb-ctl">
                                  {showsQuantity(item?.unit) ? (
                                    <input
                                      className="qty"
                                      type="number"
                                      min={1}
                                      max={99}
                                      aria-label={`Quantity for ${name}`}
                                      value={p.quantity}
                                      onChange={(e) => setPicked((prev) => prev.map((x) => (x.itemCode === p.itemCode ? { ...x, quantity: Math.max(1, Number(e.target.value) || 1) } : x)))}
                                    />
                                  ) : (
                                    <span className="muted small">1</span>
                                  )}
                                </td>
                                <td className="num qb-ctl" data-label="Unit amount">
                                  <input
                                    className="amt"
                                    type="text"
                                    inputMode="decimal"
                                    aria-label={`Unit amount for ${name}`}
                                    placeholder={bookPrice(item).kind === 'range' ? 'range' : '0.00'}
                                    value={amountText[p.itemCode] ?? ''}
                                    onChange={(e) => setAmount(p.itemCode, e.target.value)}
                                  />
                                  {off && !p.custom ? <s className="qb-book" title="the book price">{bookWords(item)}</s> : null}
                                </td>
                                <td className="num" data-label="Total">{p.isOptional ? <span className="muted">({totalWords})</span> : totalWords}</td>
                                <td className="qb-ctl">
                                  <button type="button" className="btn ghost small" aria-label={`Remove ${name}`} onClick={() => removeLine(p.itemCode)}>
                                    Remove
                                  </button>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                      {summary.hasRange ? (
                        <p className="muted small">
                          A range-priced line shows its range on the proposal and is not in the subtotal; set an amount to price it exact.
                        </p>
                      ) : null}

                      {picked.some((p) => { const l = p.custom?.serviceLine ?? itemOf(p.itemCode)?.service_line; return l === 'individual_tax' || l === 'business_tax'; }) && defaultTaxYear && taxYear ? (
                        <label className="field" style={{ marginTop: 10 }}>
                          Tax year — <strong>{taxYearLabel(taxYear, taxYearSource)}</strong>
                          <select
                            value={taxYear}
                            disabled={taxYearSource === 'interview'}
                            onChange={(e) => { setTaxYear(Number(e.target.value)); setTaxYearSource(Number(e.target.value) === defaultTaxYear ? 'default' : 'chosen'); }}
                          >
                            {taxYearOptions(defaultTaxYear).map((y) => (
                              <option key={y} value={y}>{y === defaultTaxYear ? `${y} (default — prior calendar year)` : String(y)}</option>
                            ))}
                          </select>
                          <span className="muted small">
                            The engagement is titled with it and the client reads it on the proposal.
                          </span>
                        </label>
                      ) : null}

                      <div className="qb-totals" aria-live="polite">
                        <div className="qb-total-row"><span>Subtotal</span><strong>{money(summary.committedCents)}</strong></div>
                        {packageRule && discountCents > 0 ? (
                          <div className="qb-total-row"><span>Package discount</span><strong>−{money(discountCents)}</strong></div>
                        ) : null}
                        {/* The checkbox stays (2026-09-20): the book carries no one-time / recurring attribute on
                            an item, so whether the quote is a range is still the person's call here. */}
                        <label className="field inline-check">
                          <input type="checkbox" checked={asRange} onChange={(e) => setAsRange(e.target.checked)} />
                          <span>Quote as a range (one-time work). Uncheck for recurring work, which quotes exact.</span>
                        </label>
                        <div className="qb-total-row">
                          <span>{range ? 'Quoted range' : 'Quoted'}</span>
                          <strong>{range ? `${money(range.min)}–${money(range.max)}` : money(quotedTotalCents)}</strong>
                        </div>
                        {/* Read-only on purpose: the deposit is a property of the lines, summed from the
                            book exactly as acceptance will charge it; reducing or waiving it for one client
                            is the deposit override after saving a draft. */}
                        <div className="qb-total-row">
                          <span>Deposit</span>
                          <strong>{pickedDepositCents === null ? 'none' : money(pickedDepositCents)}</strong>
                        </div>
                      </div>

                      {summary.offBook.length > 0 ? (
                        <label className="field" style={{ marginTop: 10 }}>
                          Why {summary.offBook.length === 1 ? 'is this line' : `are these ${summary.offBook.length} lines`} priced off the book? One reason for the whole quote, recorded with your name.
                          <textarea
                            rows={2}
                            value={priceChangeReason}
                            onChange={(e) => { setPriceChangeReason(e.target.value); setInlineErr((x) => (x?.key === 'reason' ? null : x)); }}
                          />
                          {errAt('reason')}
                        </label>
                      ) : null}
                      {unconfirmed.length > 0 ? (
                        <div className="alert warn">
                          {unconfirmed.length} line{unconfirmed.length === 1 ? '' : 's'} still awaiting your price
                          confirmation: {unconfirmed.map((p) => p.itemCode).join(', ')}. The quote will use the
                          seeded figure — confirm in Admin → Pricing first if that number is wrong.
                        </div>
                      ) : null}
                    </>
                  )}

                  <label className="field" style={{ marginTop: 10 }}>
                    Note to the client (optional)
                    <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
                  </label>

                  <div className="chipbar qb-actions">
                    <button
                      type="button"
                      className="btn accent qb-desk-only"
                      disabled={busy || !contact || picked.length === 0}
                      onClick={() => void buildAndSend(true)}
                    >
                      Create and send
                    </button>
                    <button
                      type="button"
                      className="btn ghost"
                      disabled={busy || !contact || picked.length === 0}
                      onClick={() => void buildAndSend(false)}
                    >
                      Save as draft
                    </button>
                    {canSavePackage && picked.length > 0 && !packageForm ? (
                      <button type="button" className="btn ghost" disabled={busy} onClick={() => { setPackageSaved(null); setPackageForm({ name: '' }); }}>
                        Save these lines as a package…
                      </button>
                    ) : null}
                  </div>
                  {errAt('build')}
                  {packageForm ? (
                    <div className="alert info" style={{ marginTop: 6 }}>
                      <label className="field">
                        Package name
                        <input type="text" value={packageForm.name} onChange={(e) => setPackageForm({ name: e.target.value })} />
                      </label>
                      {errAt('savePackage')}
                      <div className="chipbar" style={{ marginBottom: 0 }}>
                        <button type="button" className="btn small" disabled={busy} onClick={() => void savePackage()}>Save package</button>
                        <button type="button" className="btn ghost small" disabled={busy} onClick={() => setPackageForm(null)}>Cancel</button>
                      </div>
                      <p className="muted small" style={{ marginBottom: 0 }}>
                        Saved by item and quantity from the price book; the discount is set in Admin → Pricing. A custom line is not saved.
                      </p>
                    </div>
                  ) : null}
                  {packageSaved ? (
                    <p className="alert ok" style={{ marginTop: 6 }}>Saved as the package “{packageSaved.name}”; it is in the package list now.</p>
                  ) : null}
                </div>
              </div>

              {/* THE PHONE FOOTER: the total and Create and send, always in reach. */}
              {picked.length > 0 ? (
                <div className="qb-footer">
                  <span className="qb-footer-total">
                    {range ? 'Quoted range' : 'Quoted'}{' '}
                    <strong>{range ? `${money(range.min)}–${money(range.max)}` : money(quotedTotalCents)}</strong>
                  </span>
                  <button
                    type="button"
                    className="btn accent"
                    disabled={busy || !contact}
                    onClick={() => void buildAndSend(true)}
                  >
                    Create and send
                  </button>
                </div>
              ) : null}
              </>
              )}

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
                  {errAt('deposit')}
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
                    {errAt('sendDraft')}
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
                        <span className="muted small">expires {dayOf(r.expires_at)}</span>
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
