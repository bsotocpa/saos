'use client';

/*
 * THE QUOTE BUILDER, VERSION 1 (the chip builder production runs; kept 2026-09-20).
 *
 * The redesign (grouped rows beside "This quote", editable amounts under one reason, custom lines,
 * packages) is behind the server switch OPS_QUOTE_BUILDER, default v1, until Brian approves its
 * screenshots. This is the composer the pipeline page rendered before the redesign, restored from
 * git as a component and unchanged in behaviour: the same chips, the same "Quote as a range"
 * checkbox, the same picked-line rows and the same submit shape (bundleSlug or lines, with
 * includeOptional for a package). The page owns the state and the send; this renders it.
 *
 * Its submit payload is the pre-redesign one — `lines: [{ itemCode, quantity, isOptional }]`, or
 * `bundleSlug` with `includeOptional` — and the API's LineInput takes both unchanged: unitCents,
 * custom and priceChangeReason are optional there.
 */

import type { ReactNode } from 'react';
import { builderSummary, isPicked, taxYearLabel, taxYearOptions, togglePick, type PickedLine, type TaxYearSource } from './builder-lib';

export interface V1CatalogItem {
  item_code: string;
  service_line: string;
  name_en: string;
  amount_cents: number | null;
  price_min_cents: number | null;
  price_max_cents: number | null;
  is_pass_through: boolean;
  needs_confirmation: boolean;
  deposit_cents: number | null;
}
export interface V1Bundle { slug: string; name_en: string; component_count: number }

export interface BuilderV1Props {
  catalog: V1CatalogItem[];
  bundles: V1Bundle[];
  picked: PickedLine[];
  setPicked: (update: (prev: PickedLine[]) => PickedLine[]) => void;
  bundleSlug: string;
  setBundleSlug: (slug: string) => void;
  language: 'en' | 'es';
  setLanguage: (l: 'en' | 'es') => void;
  expiresInDays: number;
  setExpiresInDays: (n: number) => void;
  asRange: boolean;
  setAsRange: (on: boolean) => void;
  itemFilter: string;
  setItemFilter: (q: string) => void;
  notes: string;
  setNotes: (n: string) => void;
  /** The summed price-book deposit of the picked lines, as the page mirrors the server. */
  pickedDepositCents: number | null;
  defaultTaxYear: number | null;
  taxYear: number | null;
  taxYearSource: TaxYearSource;
  setTaxYear: (y: number) => void;
  setTaxYearSource: (s: TaxYearSource) => void;
  busy: boolean;
  hasContact: boolean;
  /** The page's send: creates the quote (and sends when asked). */
  buildAndSend: (send: boolean) => void;
  /** The page's inline error beside a control, by key. */
  errAt: (key: string) => ReactNode;
}

const money = (cents: number | null) =>
  cents === null ? '—' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);

export function BuilderV1Composer(p: BuilderV1Props): React.JSX.Element {
  const {
    catalog, bundles, picked, setPicked, bundleSlug, setBundleSlug, language, setLanguage,
    expiresInDays, setExpiresInDays, asRange, setAsRange, itemFilter, setItemFilter, notes, setNotes,
    pickedDepositCents, defaultTaxYear, taxYear, taxYearSource, setTaxYear, setTaxYearSource,
    busy, hasContact, buildAndSend, errAt,
  } = p;

  const q = itemFilter.trim().toLowerCase();
  const base = catalog.filter((i) => i.service_line !== 'deposit');
  const filtered = q.length === 0
    ? base.slice(0, 40)
    : base.filter((i) => i.name_en.toLowerCase().includes(q) || i.item_code.toLowerCase().includes(q)).slice(0, 40);

  const runningTotal = picked.reduce((sum, line) => {
    if (line.isOptional) return sum;
    const item = catalog.find((i) => i.item_code === line.itemCode);
    return sum + (item?.amount_cents ?? 0) * line.quantity;
  }, 0);
  const unconfirmed = picked.filter((line) => catalog.find((i) => i.item_code === line.itemCode)?.needs_confirmation);

  return (
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
          Package (optional)
          <select value={bundleSlug} onChange={(e) => { setBundleSlug(e.target.value); setPicked(() => []); }}>
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
            {filtered.map((i) => {
              const on = isPicked(picked, i.item_code);
              return (
                <button
                  key={i.item_code}
                  type="button"
                  className={on ? 'chip active' : 'chip'}
                  aria-pressed={on}
                  onClick={() => setPicked((prev) => togglePick(prev, i.item_code))}
                >
                  {on ? '✓ ' : ''}{i.name_en} · {money(i.amount_cents)}
                  {i.needs_confirmation ? ' ⚠' : ''}
                </button>
              );
            })}
          </div>

          {picked.some((line) => { const l = catalog.find((i) => i.item_code === line.itemCode)?.service_line; return l === 'individual_tax' || l === 'business_tax'; }) && defaultTaxYear && taxYear ? (
            <label className="field">
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
          {/* 13b: the sticky summary — deposit, committed total, line count — follows every tap. */}
          {picked.length > 0 ? (() => {
            const s = builderSummary(picked, catalog);
            return (
              <div className="builder-summary" aria-live="polite">
                <span><strong>{s.lineCount}</strong> line{s.lineCount === 1 ? '' : 's'}</span>
                <span>
                  Committed{' '}
                  <strong>
                    {s.hasRange ? `${money(s.committedMinCents)}–${money(s.committedMaxCents)}` : money(s.committedCents)}
                  </strong>
                </span>
                <span>Deposit <strong>{s.depositCents === null ? 'none' : money(s.depositCents)}</strong></span>
              </div>
            );
          })() : null}
          {picked.map((line, idx) => {
            const item = catalog.find((i) => i.item_code === line.itemCode);
            return (
              <div className="quote-line" key={line.itemCode}>
                <span className="name">{item?.name_en ?? line.itemCode}</span>
                <label className="ctl">
                  Qty
                  <input
                    type="number"
                    min={1}
                    max={99}
                    value={line.quantity}
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
                    checked={line.isOptional}
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
                  {line.isOptional ? '—' : money((item?.amount_cents ?? 0) * line.quantity)}
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
              confirmation: {unconfirmed.map((line) => line.itemCode).join(', ')}. The quote will use the
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
          disabled={busy || !hasContact || (!bundleSlug && picked.length === 0)}
          onClick={() => buildAndSend(true)}
        >
          Create and send
        </button>
        <button
          type="button"
          className="btn ghost"
          disabled={busy || !hasContact || (!bundleSlug && picked.length === 0)}
          onClick={() => buildAndSend(false)}
        >
          Save as draft
        </button>
      </div>
      {errAt('build')}
    </>
  );
}
