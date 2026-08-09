'use client';

// Reports & KPIs (M27). Owner-facing analytics with CSV export.
//
// The caveat under each report is not fine print — it is the difference between
// a number you can act on and a number that looks like it means more than it
// does. It renders with the data, every time.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, formatMoney, isAuthed } from '../../lib/api';

interface Column { key: string; label: string; type: 'text' | 'money' | 'int' | 'percent' | 'date' }
interface ReportMeta {
  key: string;
  title: string;
  description: string;
  columns: Column[];
  caveat: string | null;
  snapshot: boolean;
}
interface ReportResult {
  key: string;
  title: string;
  columns: Column[];
  caveat: string | null;
  snapshot: boolean;
  range: { from: string; to: string };
  rows: Array<Record<string, unknown>>;
}

function renderCell(value: unknown, type: Column['type']): string {
  if (value === null || value === undefined) return '—';
  if (type === 'money') return formatMoney(Number(value));
  return String(value);
}

export default function ReportsPage() {
  const router = useRouter();
  const [catalog, setCatalog] = useState<ReportMeta[]>([]);
  const [active, setActive] = useState<string>('');
  const [result, setResult] = useState<ReportResult | null>(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [tiles, setTiles] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!isAuthed()) {
      router.replace('/login');
      return;
    }
    void (async () => {
      try {
        const [c, t] = await Promise.all([
          api<{ reports: ReportMeta[]; defaultRange: { from: string; to: string } }>('/reports'),
          api<{ tiles: string[] }>('/reports/tiles/mine'),
        ]);
        setCatalog(c.reports);
        setFrom(c.defaultRange.from);
        setTo(c.defaultRange.to);
        setTiles(t.tiles);
        setActive(c.reports[0]?.key ?? '');
      } catch (err) {
        setError((err as Error).message);
      }
    })();
  }, [router]);

  const load = useCallback(async () => {
    if (!active || !from || !to) return;
    setBusy(true);
    setError('');
    try {
      setResult(await api<ReportResult>(`/reports/${active}?from=${from}&to=${to}`));
    } catch (err) {
      setError((err as Error).message);
      setResult(null);
    } finally {
      setBusy(false);
    }
  }, [active, from, to]);

  useEffect(() => {
    void load();
  }, [load]);

  const meta = useMemo(() => catalog.find((r) => r.key === active), [catalog, active]);

  const toggleTile = async (key: string) => {
    const next = tiles.includes(key) ? tiles.filter((t) => t !== key) : [...tiles, key];
    setTiles(next);
    try {
      await api('/reports/tiles/mine', { method: 'PUT', body: { tiles: next } });
    } catch (err) {
      setError((err as Error).message);
    }
  };

  // The export goes through a normal navigation so the browser handles the
  // download; the API sets content-disposition and audits the export.
  const exportCsv = () => {
    window.location.href = `/api/reports/${active}?from=${from}&to=${to}&format=csv`;
  };

  const totals = useMemo(() => {
    if (!result) return [];
    return result.columns
      .filter((c) => c.type === 'money' || c.type === 'int')
      .map((c) => ({
        label: c.label,
        type: c.type,
        value: result.rows.reduce((sum, r) => sum + (Number(r[c.key]) || 0), 0),
      }));
  }, [result]);

  return (
    <>
      <h1>Reports</h1>
      {error ? <div className="alert error">{error}</div> : null}

      <div className="chipbar">
        {catalog.map((r) => (
          <button
            key={r.key}
            type="button"
            className={`chip ${r.key === active ? 'active' : ''}`}
            onClick={() => setActive(r.key)}
          >
            {r.title}
          </button>
        ))}
      </div>

      <section className="card" style={{ marginBottom: 12 }}>
        <div className="grid2">
          <label className="field">
            From
            <input
              type="date"
              value={from}
              disabled={meta?.snapshot}
              onChange={(e) => setFrom(e.target.value)}
            />
          </label>
          <label className="field">
            To
            <input
              type="date"
              value={to}
              disabled={meta?.snapshot}
              onChange={(e) => setTo(e.target.value)}
            />
          </label>
        </div>
        <div className="chipbar">
          <button type="button" className="btn accent" disabled={busy || !result} onClick={exportCsv}>
            Export CSV
          </button>
          {/* Ghost, not danger: pinning is a preference, and red should stay
              reserved for things that actually destroy something. */}
          <button
            type="button"
            className="btn ghost"
            disabled={!active}
            onClick={() => void toggleTile(active)}
          >
            {tiles.includes(active) ? '★ Pinned — unpin' : '☆ Pin to dashboard'}
          </button>
          {meta?.snapshot ? (
            <span className="muted small">Snapshot — as of today, so the dates are off.</span>
          ) : null}
        </div>
      </section>

      {meta ? (
        <section className="card" style={{ marginBottom: 12 }}>
          <h2>{meta.title}</h2>
          <p className="muted small">{meta.description}</p>
          {meta.caveat ? (
            <div className="alert info" style={{ marginTop: 8, marginBottom: 0 }}>
              <strong>What this number is and isn&apos;t:</strong> {meta.caveat}
            </div>
          ) : null}
        </section>
      ) : null}

      {busy && !result ? <p className="muted">Loading…</p> : null}

      {result ? (
        <>
          {totals.length > 0 && result.rows.length > 0 ? (
            <section className="card" style={{ marginBottom: 12 }}>
              <div className="stat-row">
                {totals.map((t) => (
                  <div key={t.label}>
                    <div className="stat">
                      {t.type === 'money' ? formatMoney(t.value) : t.value}
                    </div>
                    <div className="muted small">Total {t.label.toLowerCase()}</div>
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          <section className="card">
            {result.rows.length === 0 ? (
              <p className="muted">
                No rows for this range. That is an answer, not an error — nothing happened in the window.
              </p>
            ) : (
              <>
                {/* Table for wide screens; the card scrolls it rather than the page. */}
                <table className="dense report-table">
                  <thead>
                    <tr>
                      {result.columns.map((c) => (
                        <th key={c.key} className="nosort">{c.label}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {result.rows.map((row, i) => (
                      <tr key={i}>
                        {result.columns.map((c) => (
                          <td key={c.key} className={c.type === 'money' || c.type === 'int' ? 'num' : ''}>
                            {renderCell(row[c.key], c.type)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>

                {/* Phone: one card per row, so nothing clips at 390px. */}
                <div className="report-cards">
                  {result.rows.map((row, i) => (
                    <div className="report-card" key={i}>
                      {result.columns.map((c) => (
                        <div className="rc-line" key={c.key}>
                          <span className="rc-label">{c.label}</span>
                          <span className="rc-value">{renderCell(row[c.key], c.type)}</span>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              </>
            )}
          </section>
        </>
      ) : null}
    </>
  );
}
