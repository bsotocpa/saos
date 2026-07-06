'use client';

// Get an Estimate (MP): guided questionnaire → price RANGE (never an exact
// figure) → consultation booking (Cal.com embed lands with M18).

import { useState } from 'react';
import { api, formatMoney } from '../../lib/api';
import { useSession } from '../../lib/session';
import type { DictKey } from '../../lib/i18n';

export default function EstimatePage() {
  const { t } = useSession();
  const [filingStatus, setFilingStatus] = useState('single');
  const [schC, setSchC] = useState(0);
  const [rentals, setRentals] = useState(0);
  const [k1s, setK1s] = useState(0);
  const [states, setStates] = useState(1);
  const [businessReturn, setBusinessReturn] = useState('none');
  const [range, setRange] = useState<{ minCents: number; maxCents: number } | null>(null);
  const [busy, setBusy] = useState(false);

  const number = (value: number, set: (n: number) => void, max: number) => (
    <input
      type="number"
      min={0}
      max={max}
      value={value}
      onChange={(e) => set(Math.max(0, Math.min(max, Number(e.target.value) || 0)))}
    />
  );

  return (
    <>
      <h1>{t('est_title')}</h1>
      <p className="muted">{t('est_intro')}</p>
      <section className="card">
        <label className="field">
          {t('est_filing_status')}
          <select value={filingStatus} onChange={(e) => setFilingStatus(e.target.value)}>
            {(['single', 'mfj', 'mfs', 'hoh'] as const).map((fs) => (
              <option key={fs} value={fs}>
                {t(`fs_${fs}` as DictKey)}
              </option>
            ))}
          </select>
        </label>
        <div className="grid2">
          <label className="field">
            {t('est_schc')}
            {number(schC, setSchC, 10)}
          </label>
          <label className="field">
            {t('est_rentals')}
            {number(rentals, setRentals, 20)}
          </label>
          <label className="field">
            {t('est_k1s')}
            {number(k1s, setK1s, 20)}
          </label>
          <label className="field">
            {t('est_states')}
            <input
              type="number"
              min={1}
              max={10}
              value={states}
              onChange={(e) => setStates(Math.max(1, Math.min(10, Number(e.target.value) || 1)))}
            />
          </label>
        </div>
        <label className="field">
          {t('est_bizreturn')}
          <select value={businessReturn} onChange={(e) => setBusinessReturn(e.target.value)}>
            <option value="none">{t('biz_none')}</option>
            <option value="1065">1065</option>
            <option value="1120s">1120-S</option>
            <option value="1120">1120</option>
          </select>
        </label>
        <button
          className="btn"
          type="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const r = await api<{ minCents: number; maxCents: number }>('/portal/estimate', {
                method: 'POST',
                body: { filingStatus, schC, rentals, k1s, states, businessReturn },
              });
              setRange(r);
            } finally {
              setBusy(false);
            }
          }}
        >
          {t('est_calc')}
        </button>
      </section>

      {range ? (
        <section className="card" style={{ textAlign: 'center' }} data-testid="estimate-range">
          <h2>{t('est_range_title')}</h2>
          <div className="range-figure">
            {formatMoney(range.minCents)} – {formatMoney(range.maxCents)}
          </div>
          <p className="muted small">{t('est_range_note')}</p>
          <a className="btn accent" href="/request-service">
            {t('est_book')}
          </a>
        </section>
      ) : null}
    </>
  );
}
