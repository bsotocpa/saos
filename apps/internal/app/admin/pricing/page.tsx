'use client';

/*
 * Price book admin — rebuilt for v4 (Brian, 2026-08-14).
 *
 * "The current sheet conflates deposits with service pricing, which is why the 13
 * confirmations have stalled." So price and deposit are separate, visibly, everywhere:
 * separate columns on desktop, separate labelled fields on a phone, and separate
 * confirmations — answering "is that the right price" is not the same tap as answering
 * "should this line ask for a deposit at all".
 *
 * THE PHONE IS THE PRIMARY TARGET, not the fallback: Brian does all pricing
 * confirmations in one sitting at 390px. The old page was a bare <table>, which on a
 * phone is a horizontal scroll with the item name pushed off-screen — unusable for the
 * one job this page exists to do. Desktop keeps the dense table; the phone gets cards
 * (the .desk-only/.phone-only pattern the reports use).
 *
 * The queue GROUPS by question, because the v4 migration asks the same thing of twelve
 * lines at once and tapping "confirm" twelve times to answer one question is not a
 * decision, it is data entry.
 *
 * Every edit still creates a NEW effective-dated version; existing engagements keep the
 * version pinned at signing.
 */

import { useEffect, useState } from 'react';
import { api, formatMoney } from '../../../lib/api';

interface Item {
  item_code: string; service_line: string; name_en: string;
  amount_cents: number | null; price_min_cents: number | null; price_max_cents: number | null;
  unit: string; is_pass_through: boolean; is_active: boolean;
  needs_confirmation: boolean; confirmation_note: string | null;
  pricing_mode: 'flat' | 'range' | 'hourly' | 'percent';
  deposit_cents: number | null;
  percent_rate: string | null;
  structure_needs_confirmation: boolean; structure_confirmation_note: string | null;
}
interface Book {
  version: { version_number: number; effective_from: string; note: string | null; pending: boolean };
  items: Item[];
}
type Kind = 'price' | 'structure';
interface Pending { kind: Kind; note: string; items: Item[] }



/** What this line charges, in the shape its mode says it is. */
function priceLabel(i: Item): string {
  // A percent line has no fixed price — the RATE is the price. Showing a dollar figure
  // here is what let a flat $25 sit on the late-fee line while 1.5% did the charging.
  if (i.pricing_mode === 'percent') {
    return i.percent_rate === null ? '—' : `${Number(i.percent_rate)}% per ${i.unit.replace('per_', '')}`;
  }
  if (i.pricing_mode === 'range') {
    return `${formatMoney(i.price_min_cents ?? 0)}–${formatMoney(i.price_max_cents ?? 0)}`;
  }
  return i.amount_cents === null ? '—' : formatMoney(i.amount_cents);
}

const modeBadge = (m: Item['pricing_mode']): string =>
  m === 'range' ? 'warn' : m === 'hourly' || m === 'percent' ? 'ok' : '';

export default function PricingAdminPage() {
  const [book, setBook] = useState<Book | null>(null);
  // Two separate edit maps — the whole point of v4 is that these are different numbers.
  const [priceEdits, setPriceEdits] = useState<Record<string, string>>({});
  const [depositEdits, setDepositEdits] = useState<Record<string, string>>({});
  const [effectiveFrom, setEffectiveFrom] = useState('');
  const [note, setNote] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async () => setBook(await api<Book>('/admin/price-book'));
  useEffect(() => {
    void load().catch((e: unknown) => setError(e instanceof Error ? e.message : 'Could not load the price book.'));
  }, []);

  if (error && !book) return <p className="alert error">{error}</p>;
  if (!book) return <p className="muted">Loading…</p>;

  /*
   * The queue, grouped by the QUESTION rather than by item. Twelve lines carrying the
   * same v4 deposit question are one decision with twelve consequences, so they are
   * presented that way and can be answered in one tap.
   */
  const groups: Pending[] = [];
  const bucket = (kind: Kind, note: string, item: Item) => {
    const key = `${kind}::${note}`;
    const found = groups.find((g) => `${g.kind}::${g.note}` === key);
    if (found) found.items.push(item);
    else groups.push({ kind, note, items: [item] });
  };
  for (const i of book.items) {
    if (i.needs_confirmation) bucket('price', i.confirmation_note ?? 'Confirm this price.', i);
    if (i.structure_needs_confirmation) {
      bucket('structure', i.structure_confirmation_note ?? 'Confirm how this line is structured.', i);
    }
  }
  const pendingCount = groups.reduce((n, g) => n + g.items.length, 0);

  const confirm = async (code: string, kind: Kind) => {
    await api(`/admin/price-book/items/${code}/confirm?kind=${kind}`, { method: 'POST' });
  };

  const confirmGroup = async (g: Pending) => {
    setBusy(true);
    setError('');
    try {
      // Sequential, not Promise.all: each is an audited decision, and a partial failure
      // should stop rather than leave a half-answered question with no error.
      for (const i of g.items) await confirm(i.item_code, g.kind);
      setMessage(`Confirmed ${g.items.length} line${g.items.length === 1 ? '' : 's'}.`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not confirm.');
    } finally {
      setBusy(false);
    }
  };

  // A change carries only the fields actually edited, so an untouched deposit is not
  // rewritten to its current value (which would read as a deliberate decision).
  const changes = book.items
    .map((i) => {
      const p = priceEdits[i.item_code];
      const d = depositEdits[i.item_code];
      if (p === undefined && d === undefined) return null;
      const change: Record<string, unknown> = { itemCode: i.item_code };
      /*
       * On a percent line the number in the box IS the rate, not dollars. Sending it as
       * amountCents is what produced finding #25 — a flat $25 written onto a line whose
       * real 1.5% lived somewhere the page never showed.
       */
      if (p !== undefined) {
        if (i.pricing_mode === 'percent') change.percentRate = Number(p);
        else change.amountCents = Math.round(Number(p) * 100);
      }
      // Empty deposit field = this line stops asking for one, which is a real edit.
      if (d !== undefined) change.depositCents = d === '' ? null : Math.round(Number(d) * 100);
      return change;
    })
    .filter((c): c is Record<string, unknown> => c !== null);

  const setEdit = (
    setter: React.Dispatch<React.SetStateAction<Record<string, string>>>,
    code: string,
    value: string,
    allowEmpty: boolean
  ) => {
    setter((prev) => {
      const next = { ...prev };
      if (value === '' && !allowEmpty) delete next[code];
      else next[code] = value;
      return next;
    });
  };

  const editable = book.items.filter((i) => !i.is_pass_through && i.is_active);

  return (
    <>
      <h1>
        Price book{' '}
        <span className={`badge ${book.version.pending ? 'warn' : ''}`}>
          v{book.version.version_number} ·{' '}
          {book.version.pending ? 'takes effect' : 'effective'} {book.version.effective_from.slice(0, 10)}
        </span>
      </h1>
      {message ? <p className="alert info">{message}</p> : null}
      {error ? <p className="alert error">{error}</p> : null}

      {/* ── The confirmation queue ─────────────────────────────────────────── */}
      {groups.length > 0 ? (
        <section className="card" style={{ borderColor: 'var(--warn)' }}>
          <h2>⚠ Awaiting your confirmation ({pendingCount})</h2>
          <p className="muted small">
            Grouped by question. A <strong>price</strong> question means the amount itself is
            unsettled and any quote using the line is provisional. A <strong>structure</strong>{' '}
            question is about how the line works — whether it asks for a deposit, whether it is
            really hourly — and does not make a quote provisional.
          </p>
          {groups.map((g) => (
            <div
              key={`${g.kind}::${g.note}`}
              style={{ borderTop: '1px solid var(--line)', paddingTop: 10, marginTop: 10 }}
            >
              <p className="small" style={{ margin: '0 0 6px' }}>
                <span className={`badge ${g.kind === 'price' ? 'danger' : 'warn'}`}>{g.kind}</span>{' '}
                {g.note}
              </p>
              {g.items.map((i) => (
                <p key={i.item_code} className="small" style={{ margin: '4px 0' }}>
                  <strong>{i.name_en}</strong>
                  <span className="muted">
                    {' '}· {priceLabel(i)}
                    {i.deposit_cents !== null ? ` · deposit ${formatMoney(i.deposit_cents)}` : ''}
                    {i.unit !== 'flat' ? ` · ${i.unit.replaceAll('_', ' ')}` : ''}
                  </span>{' '}
                  <button
                    type="button"
                    className="btn ghost"
                    disabled={busy}
                    onClick={() => void confirmGroup({ ...g, items: [i] })}
                  >
                    Confirm
                  </button>
                </p>
              ))}
              {g.items.length > 1 ? (
                <button type="button" className="btn accent" disabled={busy} onClick={() => void confirmGroup(g)}>
                  Confirm all {g.items.length}
                </button>
              ) : null}
            </div>
          ))}
        </section>
      ) : (
        <p className="alert info">Nothing awaiting confirmation.</p>
      )}

      {/* ── Items: dense table on desktop ──────────────────────────────────── */}
      <section className="card">
        <h2>Items — enter new values to stage a version</h2>
        <p className="muted small">
          Price and deposit are separate. Leaving the deposit blank on a line that has one
          removes it.
        </p>

        <table className="desk-only">
          <thead>
            <tr>
              <th>Item</th><th>Mode</th><th>Price</th><th>Deposit</th>
              <th>New price / rate</th><th>New deposit ($)</th>
            </tr>
          </thead>
          <tbody>
            {editable.map((i) => (
              <tr key={i.item_code}>
                <td>
                  {i.name_en}{' '}
                  {i.needs_confirmation ? <span className="badge danger">⚠ price</span> : null}
                  {i.structure_needs_confirmation ? <span className="badge warn">⚠ structure</span> : null}
                  {i.unit !== 'flat' ? <span className="muted small"> · {i.unit.replaceAll('_', ' ')}</span> : null}
                </td>
                <td><span className={`badge ${modeBadge(i.pricing_mode)}`}>{i.pricing_mode}</span></td>
                <td>{priceLabel(i)}</td>
                <td>{i.deposit_cents === null ? <span className="muted">—</span> : formatMoney(i.deposit_cents)}</td>
                <td style={{ width: 110 }}>
                  <input
                    type="number" step="0.01" min="0" inputMode="decimal"
                    value={priceEdits[i.item_code] ?? ''}
                    onChange={(e) => setEdit(setPriceEdits, i.item_code, e.target.value, false)}
                  />
                </td>
                <td style={{ width: 110 }}>
                  {i.pricing_mode === 'percent' ? (
                    <span className="muted small">n/a</span>
                  ) : (
                    <input
                      type="number" step="0.01" min="0" inputMode="decimal"
                      value={depositEdits[i.item_code] ?? ''}
                      onChange={(e) => setEdit(setDepositEdits, i.item_code, e.target.value, true)}
                    />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* ── Same data as cards on a phone ─────────────────────────────────── */}
        <div className="phone-only">
          {editable.map((i) => (
            <div key={i.item_code} style={{ borderTop: '1px solid var(--line)', padding: '10px 0' }}>
              <p className="small" style={{ margin: 0, fontWeight: 600 }}>
                {i.name_en}{' '}
                {i.needs_confirmation ? <span className="badge danger">⚠ price</span> : null}
                {i.structure_needs_confirmation ? <span className="badge warn">⚠ structure</span> : null}
              </p>
              <p className="muted small" style={{ margin: '2px 0 8px' }}>
                <span className={`badge ${modeBadge(i.pricing_mode)}`}>{i.pricing_mode}</span>{' '}
                {priceLabel(i)}
                {i.deposit_cents !== null ? ` · deposit ${formatMoney(i.deposit_cents)}` : ' · no deposit'}
                {i.unit !== 'flat' ? ` · ${i.unit.replaceAll('_', ' ')}` : ''}
              </p>
              <label className="field">
                {i.pricing_mode === 'percent' ? 'New rate (%)' : 'New price ($)'}
                <input
                  type="number" step="0.01" min="0" inputMode="decimal"
                  value={priceEdits[i.item_code] ?? ''}
                  onChange={(e) => setEdit(setPriceEdits, i.item_code, e.target.value, false)}
                />
              </label>
              {i.pricing_mode === 'percent' ? null : (
                <label className="field">
                  New deposit ($) — blank removes it
                  <input
                    type="number" step="0.01" min="0" inputMode="decimal"
                    value={depositEdits[i.item_code] ?? ''}
                    onChange={(e) => setEdit(setDepositEdits, i.item_code, e.target.value, true)}
                  />
                </label>
              )}
            </div>
          ))}
        </div>
      </section>

      {changes.length > 0 ? (
        <section className="card" style={{ borderColor: 'var(--electric)' }}>
          <h2>
            Create version v{book.version.version_number + 1} ({changes.length} change
            {changes.length > 1 ? 's' : ''})
          </h2>
          <p className="muted small">
            Existing engagements keep their locked version — this reprices new work only, from
            the date below.
          </p>
          <label className="field">
            Effective from
            <input type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} />
          </label>
          <label className="field">
            Note (why)
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. 2027 season adjustment" />
          </label>
          <button
            className="btn accent"
            type="button"
            disabled={!effectiveFrom || note.length < 3 || busy}
            onClick={async () => {
              setBusy(true);
              setError('');
              try {
                const res = await api<{ versionNumber: number }>('/admin/price-book/versions', {
                  method: 'POST',
                  body: { effectiveFrom, note, changes },
                });
                setMessage(`Version v${res.versionNumber} created — effective ${effectiveFrom}.`);
                setPriceEdits({});
                setDepositEdits({});
                setNote('');
                await load();
              } catch (e) {
                setError(e instanceof Error ? e.message : 'Could not publish the version.');
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? 'Publishing…' : 'Publish new version'}
          </button>
        </section>
      ) : null}
    </>
  );
}
