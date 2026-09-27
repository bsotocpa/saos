'use client';

/*
 * THE OPS QUOTE PAGE (Brian, 2026-09-20, the Quotes card). The send confirmation on /pipeline has
 * told staff to "open the client and edit or resend this one" since M27, and nothing in Ops could
 * open a quote by itself. This is the page the card's Open control lands on: the staff view of one
 * quote — who and which business it is for, its lines as agreed (both languages frozen on the
 * line), the deposit the server resolves, its dates and its state — read from GET /quotes/:id and
 * never computed here. The controls stay on the client page's card, beside the record.
 *
 * R75 (2026-09-27): the money reads as the server holds it — Subtotal, the package discount, the Hilo
 * referral discount as its own line (or, once removed, when and why), Total, Deposit. The one control
 * here is the referral discount's removal: the CEO alone (the explicit-only
 * quotes.referral_discount.remove, which '*' does not grant), on a draft or sent quote that still
 * carries it, with a reason, through the app's own modal. Nothing here widens or sets it.
 */

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useAsk } from '../../../components/ask';
import { api, formatMoney, isAuthed } from '../../../lib/api';
import { dayOf } from '../../../lib/dates';
import { quoteStatusLabel } from '../../../lib/labels';
import { referralRowLabel } from '../../pipeline/builder-lib';

interface QuoteRow {
  id: string; status: string; language: string; contact_id: string; business_id: string | null;
  first_name: string; last_name: string; business_name: string | null;
  subtotal_cents: number; discount_cents: number;
  referral_discount_cents: number; referral_discount_label_en: string | null; referral_discount_label_es: string | null;
  referral_discount_rate: string | null; referral_discount_removed_at: string | null;
  referral_discount_removed_reason: string | null;
  total_cents: number; range_min_cents: number | null; range_max_cents: number | null;
  created_at: string; sent_at: string | null; expires_at: string | null; accepted_at: string | null;
  declined_at: string | null; decline_reason: string | null; notes: string | null; bundle_slug: string | null;
}
interface Line {
  item_code: string; description_en: string; description_es: string; quantity: string;
  unit_cents: number | null; line_cents: number | null; min_cents: number | null; max_cents: number | null;
  is_optional: boolean; chosen: boolean; is_pass_through: boolean;
}
interface Detail {
  quote: QuoteRow | null;
  lines: Line[];
  periods?: Array<{ periodKey: string; serviceLine: string }>;
  deposit: { standardCents: number; chargeCents: number; treatment: string; reason: string | null; overriddenAt: string | null } | null;
}

export default function OpsQuotePage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const ask = useAsk();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState('');
  /** R75: the explicit-only key, checked for itself exactly as the API does — '*' does not imply it. */
  const [canRemoveReferral, setCanRemoveReferral] = useState(false);

  /** The quote as the server holds it: read on arrival and again after every change. */
  const load = useCallback(async () => {
    try {
      setDetail(await api<Detail>(`/quotes/${params.id}`));
      setError('');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Could not load the quote.');
    }
  }, [params.id]);

  useEffect(() => {
    if (!isAuthed()) { router.replace('/login'); return; }
    void load();
    let alive = true;
    api<{ permissions: string[] }>('/auth/me')
      .then((me) => { if (alive) setCanRemoveReferral(me.permissions.includes('quotes.referral_discount.remove')); })
      .catch(() => { if (alive) setCanRemoveReferral(false); });
    return () => { alive = false; };
  }, [load, router]);

  if (error) return <div className="card"><p className="alert warn" role="alert">{error}</p></div>;
  if (!detail) return <p className="muted">Loading…</p>;
  const q = detail.quote;
  if (!q) return <div className="card"><p className="muted">No such quote.</p></div>;
  const amount = q.range_min_cents !== null && q.range_max_cents !== null
    ? `${formatMoney(q.range_min_cents)}–${formatMoney(q.range_max_cents)}`
    : formatMoney(q.total_cents);
  // R75: the referral discount as the quote carries it — the book's label and rate, frozen on the quote.
  const referralLabel = q.referral_discount_label_en && q.referral_discount_rate !== null
    ? referralRowLabel({ labelEn: q.referral_discount_label_en, rate: Number(q.referral_discount_rate) })
    : null;
  const referralCarried = referralLabel !== null && q.referral_discount_removed_at === null;
  const referralRemoved = q.referral_discount_removed_at !== null;
  const mayRemoveReferral = canRemoveReferral && referralCarried && (q.status === 'draft' || q.status === 'sent');

  const removeReferral = async () => {
    const a = await ask({
      title: 'Remove the Hilo referral discount from this quote?',
      body: (
        <p className="small">
          The total rises by {formatMoney(q.referral_discount_cents)} and the deposit returns to the price book&apos;s.
          The removal is kept on the quote with your name and reason, and the client&apos;s proposal shows the new total.
          Nothing puts the discount back.
        </p>
      ),
      reason: { label: 'Why is the discount being removed?', required: true },
      choices: [{ key: 'remove', label: 'Remove the discount', tone: 'danger' }],
      run: async (r) => { await api(`/quotes/${q.id}/referral-discount/remove`, { method: 'POST', body: { reason: r.reason } }); },
    });
    if (!a) return;
    await load();
  };

  return (
    <>
      <h1>
        Quote{' '}
        <span className={`badge ${q.status === 'accepted' ? 'ok' : q.status === 'sent' ? '' : 'warn'}`}>{quoteStatusLabel(q.status)}</span>
      </h1>
      <p className="muted small">
        For <a href={`/clients/${q.contact_id}`}>{q.first_name} {q.last_name}</a>
        {q.business_name ? ` · ${q.business_name}` : ''}
        {' · '}{q.language === 'es' ? 'Spanish' : 'English'}
      </p>
      <div className="cards">
        <section className="card">
          <h2>What was quoted</h2>
          {detail.lines.length === 0 ? <p className="muted small">No lines.</p> : detail.lines.map((l) => (
            <div className="quote-line" key={l.item_code + l.description_en}>
              <span className="name">
                {l.description_en}{' '}
                <span className="badge">{l.item_code}</span>
                {l.is_optional ? <> <span className="badge">{l.chosen ? 'optional, chosen' : 'optional, not chosen'}</span></> : null}
                {l.is_pass_through ? <> <span className="badge">pass-through</span></> : null}
              </span>
              <span className="muted small">{l.description_es}</span>
              <span className="amt">
                {l.min_cents !== null && l.max_cents !== null
                  ? `${formatMoney(l.min_cents)}–${formatMoney(l.max_cents)}`
                  : l.line_cents !== null ? formatMoney(l.line_cents) : '—'}
                {Number(l.quantity) !== 1 ? ` × ${l.quantity}` : ''}
              </span>
            </div>
          ))}
          <div className="qb-totals">
            <div className="qb-total-row" data-testid="quote-subtotal"><span>Subtotal</span><strong>{formatMoney(q.subtotal_cents)}</strong></div>
            {q.discount_cents > 0 ? (
              <div className="qb-total-row">
                <span>Package discount{q.bundle_slug ? <span className="muted small"> · bundle {q.bundle_slug}</span> : null}</span>
                <strong>−{formatMoney(q.discount_cents)}</strong>
              </div>
            ) : null}
            {referralCarried ? (
              <div className="qb-total-row" data-testid="quote-referral-discount">
                <span>{referralLabel}</span><strong>−{formatMoney(q.referral_discount_cents)}</strong>
              </div>
            ) : null}
            {referralRemoved ? (
              <p className="muted small" data-testid="quote-referral-removed" style={{ overflowWrap: 'anywhere' }}>
                {q.referral_discount_label_en ?? 'Referral discount'} removed {dayOf(q.referral_discount_removed_at)}
                {q.referral_discount_removed_reason ? ` — ${q.referral_discount_removed_reason}` : ''}
              </p>
            ) : null}
            <div className="qb-total-row" data-testid="quote-total">
              <span>{q.range_min_cents !== null && q.range_max_cents !== null ? 'Total (range)' : 'Total'}</span><strong>{amount}</strong>
            </div>
            {detail.deposit ? (
              <div className="qb-total-row" data-testid="quote-deposit">
                <span>Deposit</span>
                <strong>
                  {detail.deposit.treatment === 'waived' ? 'waived' : formatMoney(detail.deposit.chargeCents)}
                  {detail.deposit.chargeCents !== detail.deposit.standardCents ? <span className="muted"> (standard {formatMoney(detail.deposit.standardCents)})</span> : null}
                </strong>
              </div>
            ) : null}
            {detail.deposit?.reason ? <p className="muted small">{detail.deposit.reason}</p> : null}
          </div>
          {q.bundle_slug && q.discount_cents === 0 ? <p className="muted small">Bundle {q.bundle_slug}</p> : null}
          {mayRemoveReferral ? (
            <p style={{ marginTop: 8 }}>
              <button type="button" className="btn ghost small" data-testid="remove-referral-discount" onClick={() => void removeReferral()}>
                Remove the Hilo discount…
              </button>
            </p>
          ) : null}
        </section>
        <section className="card">
          <h2>Where it stands</h2>
          <p className="small">
            Created {dayOf(q.created_at)}
            {q.sent_at ? <><br />Sent {dayOf(q.sent_at)}</> : null}
            {q.expires_at ? <><br />Expires {dayOf(q.expires_at)}</> : null}
            {q.accepted_at ? <><br />Accepted {dayOf(q.accepted_at)}</> : null}
            {q.declined_at ? <><br />Declined {dayOf(q.declined_at)}{q.decline_reason ? ` — ${q.decline_reason}` : ''}</> : null}
          </p>
          {detail.periods && detail.periods.length > 0 ? (
            <p className="muted small">Periods: {detail.periods.map((p) => `${p.serviceLine} ${p.periodKey}`).join(', ')}</p>
          ) : null}
          {q.notes ? <p className="small">{q.notes}</p> : null}
          <p className="muted small">Copy the client link, resend the proposal or withdraw a draft from the client&apos;s record.</p>
        </section>
      </div>
    </>
  );
}
