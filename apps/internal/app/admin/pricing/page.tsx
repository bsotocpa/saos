'use client';

// Price book admin (MP v4.2): every edit creates a NEW effective-dated
// version — existing engagements keep the version pinned at signing. The ⚠
// queue is the launch-gate list of seed conflicts awaiting Brian.

import { useEffect, useState } from 'react';
import { api, formatMoney } from '../../../lib/api';

interface Item {
  item_code: string; service_line: string; name_en: string;
  amount_cents: number | null; price_min_cents: number | null; price_max_cents: number | null;
  unit: string; is_pass_through: boolean; needs_confirmation: boolean; confirmation_note: string | null;
}
interface Book {
  version: { version_number: number; effective_from: string; note: string | null };
  items: Item[];
}

export default function PricingAdminPage() {
  const [book, setBook] = useState<Book | null>(null);
  const [edits, setEdits] = useState<Record<string, number>>({});
  const [effectiveFrom, setEffectiveFrom] = useState('');
  const [note, setNote] = useState('');
  const [message, setMessage] = useState('');

  const load = async () => setBook(await api<Book>('/admin/price-book'));
  useEffect(() => {
    void load();
  }, []);

  if (!book) return <p className="muted">Loading…</p>;

  const flagged = book.items.filter((i) => i.needs_confirmation);
  const changes = Object.entries(edits).map(([itemCode, dollars]) => ({
    itemCode,
    amountCents: Math.round(dollars * 100),
  }));

  return (
    <>
      <h1>
        Price book <span className="badge">v{book.version.version_number} · effective {book.version.effective_from.slice(0, 10)}</span>
      </h1>
      {message ? <p className="alert info">{message}</p> : null}

      {flagged.length > 0 ? (
        <section className="card" style={{ borderColor: 'var(--warn)' }}>
          <h2>⚠ Awaiting your confirmation (launch gate)</h2>
          {flagged.map((i) => (
            <p key={i.item_code} className="small">
              <strong>{i.name_en}</strong> — {i.amount_cents !== null ? formatMoney(i.amount_cents) : `${formatMoney(i.price_min_cents ?? 0)}–${formatMoney(i.price_max_cents ?? 0)}`}
              <br />
              <span className="muted">{i.confirmation_note}</span>
              <br />
              <button
                className="btn ghost"
                type="button"
                onClick={async () => {
                  await api(`/admin/price-book/items/${i.item_code}/confirm`, { method: 'POST' });
                  setMessage(`${i.item_code} confirmed as seeded.`);
                  await load();
                }}
              >
                Confirm this price
              </button>
            </p>
          ))}
        </section>
      ) : null}

      <section className="card">
        <h2>Items — enter new prices to stage a version</h2>
        <table>
          <thead><tr><th>Item</th><th>Current</th><th>Unit</th><th>New price ($)</th></tr></thead>
          <tbody>
            {book.items.filter((i) => !i.is_pass_through).map((i) => (
              <tr key={i.item_code}>
                <td>{i.name_en} {i.needs_confirmation ? <span className="badge warn">⚠</span> : null}</td>
                <td>{i.amount_cents !== null ? formatMoney(i.amount_cents) : `${formatMoney(i.price_min_cents ?? 0)}–${formatMoney(i.price_max_cents ?? 0)}`}</td>
                <td className="muted small">{i.unit}</td>
                <td style={{ width: 110 }}>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={edits[i.item_code] ?? ''}
                    onChange={(e) => {
                      const v = e.target.value;
                      setEdits((prev) => {
                        const next = { ...prev };
                        if (v === '') delete next[i.item_code];
                        else next[i.item_code] = Number(v);
                        return next;
                      });
                    }}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {changes.length > 0 ? (
        <section className="card" style={{ borderColor: 'var(--electric)' }}>
          <h2>Create version v{book.version.version_number + 1} ({changes.length} change{changes.length > 1 ? 's' : ''})</h2>
          <p className="muted small">
            Existing engagements keep their locked version — this reprices new work only, from the date below.
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
            disabled={!effectiveFrom || note.length < 3}
            onClick={async () => {
              const res = await api<{ versionNumber: number }>('/admin/price-book/versions', {
                method: 'POST',
                body: { effectiveFrom, note, changes },
              });
              setMessage(`Version v${res.versionNumber} created — effective ${effectiveFrom}.`);
              setEdits({});
              setNote('');
              await load();
            }}
          >
            Publish new version
          </button>
        </section>
      ) : null}
    </>
  );
}
