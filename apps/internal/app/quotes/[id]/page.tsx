'use client';

/*
 * THE OPS QUOTE PAGE (Brian, 2026-09-20, the Quotes card). The send confirmation on /pipeline has
 * told staff to "open the client and edit or resend this one" since M27, and nothing in Ops could
 * open a quote by itself. This is the page the card's Open control lands on: the staff view of one
 * quote — who and which business it is for, its lines as agreed (both languages frozen on the
 * line), the deposit the server resolves, its dates and its state — read from GET /quotes/:id and
 * never computed here. The controls stay on the client page's card, beside the record.
 */

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { api, formatMoney, isAuthed } from '../../../lib/api';
import { dayOf } from '../../../lib/dates';
import { quoteStatusLabel } from '../../../lib/labels';

interface QuoteRow {
  id: string; status: string; language: string; contact_id: string; business_id: string | null;
  first_name: string; last_name: string; business_name: string | null;
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
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!isAuthed()) { router.replace('/login'); return; }
    let alive = true;
    api<Detail>(`/quotes/${params.id}`)
      .then((d) => { if (alive) setDetail(d); })
      .catch((e: unknown) => { if (alive) setError(e instanceof Error ? e.message : 'Could not load the quote.'); });
    return () => { alive = false; };
  }, [params.id, router]);

  if (error) return <div className="card"><p className="alert warn" role="alert">{error}</p></div>;
  if (!detail) return <p className="muted">Loading…</p>;
  const q = detail.quote;
  if (!q) return <div className="card"><p className="muted">No such quote.</p></div>;
  const amount = q.range_min_cents !== null && q.range_max_cents !== null
    ? `${formatMoney(q.range_min_cents)}–${formatMoney(q.range_max_cents)}`
    : formatMoney(q.total_cents);

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
          <p style={{ marginTop: 8 }}><strong>{amount}</strong>{q.bundle_slug ? <span className="muted small"> · bundle {q.bundle_slug}</span> : null}</p>
          {detail.deposit ? (
            <p className="small">
              Deposit: {detail.deposit.treatment === 'waived' ? 'waived' : formatMoney(detail.deposit.chargeCents)}
              {detail.deposit.chargeCents !== detail.deposit.standardCents ? <span className="muted"> (standard {formatMoney(detail.deposit.standardCents)})</span> : null}
              {detail.deposit.reason ? <><br /><span className="muted">{detail.deposit.reason}</span></> : null}
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
