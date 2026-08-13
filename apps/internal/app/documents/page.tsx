'use client';

// FINDING #16 — the ops Documents surface.
//
// Brian, at 390px: "Everything from scan statuses to quarantine review is currently
// invisible to me." It was. The only Document Center that existed was the CLIENT
// portal's — the one my #11 walkthrough cited, which was never reachable from ops.
// Every staff document endpoint before this was scoped to one contact, so answering
// "what is quarantined right now?" required already knowing whose file to ask about.
//
// So the page leads with what is WRONG, not with a file browser. Quarantined first,
// then stuck-awaiting-scan, then everything else — the order of the list is the
// triage order. Counts sit in the chips so a quarantined file announces itself
// instead of waiting to be found.
//
// Mobile-first for real: cards at 390px, table only when there is width for one.

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api, isAuthed } from '../../lib/api';

interface Doc {
  id: string;
  filename: string;
  category: string;
  size_bytes: string | number;
  created_at: string;
  scan_status: string;
  scan_detail: string | null;
  scanned_at: string | null;
  scan_attempts: number;
  filing_deferred: boolean;
  contact_id: string;
  contact_name: string | null;
  contact_is_test: boolean;
}

interface Overview {
  documents: Doc[];
  counts: Record<string, number>;
}

/** Staff-facing wording. "skipped" is a clamd term, not a status a person should read. */
const SCAN_LABEL: Record<string, string> = {
  infected: 'Quarantined',
  pending_scan: 'Awaiting scan',
  skipped: 'Scan failed — will retry',
  not_configured: 'No scanner configured',
  clean: 'Clean',
};

const SCAN_TONE: Record<string, string> = {
  infected: 'error',
  pending_scan: 'warn',
  skipped: 'warn',
  not_configured: 'warn',
  clean: 'ok',
};

/** Guards the ?scan= deep link: an unknown value falls back to All, never a 400. */
const VALID_FILTERS = new Set(['infected', 'pending_scan', 'skipped', 'clean', 'not_configured']);

/** The filters worth having: the two that mean "something needs doing", then clean. */
const FILTERS: Array<{ key: string | null; label: string }> = [
  { key: null, label: 'All' },
  { key: 'infected', label: 'Quarantined' },
  { key: 'pending_scan', label: 'Awaiting scan' },
  { key: 'skipped', label: 'Scan failed' },
  { key: 'clean', label: 'Clean' },
];

function formatBytes(b: string | number): string {
  const n = Number(b);
  if (!Number.isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export default function DocumentsPage() {
  const router = useRouter();
  const [data, setData] = useState<Overview | null>(null);
  // Honour ?scan= so the dashboard's "Review quarantine" lands ON the quarantine
  // rather than on an unfiltered list the reader then has to filter themselves.
  // Read from location rather than useSearchParams to keep this page prerenderable.
  const [filter, setFilter] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    const wanted = new URLSearchParams(window.location.search).get('scan');
    return wanted && VALID_FILTERS.has(wanted) ? wanted : null;
  });
  const [error, setError] = useState<string | null>(null);

  const load = (scanStatus: string | null) => {
    setError(null);
    void api<Overview>(`/documents/overview${scanStatus ? `?scanStatus=${scanStatus}` : ''}`)
      .then(setData)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Could not load documents.'));
  };

  useEffect(() => {
    if (!isAuthed()) {
      router.replace('/login');
      return;
    }
    load(filter);
  }, [router, filter]);

  const counts = data?.counts ?? {};
  const quarantined = counts.infected ?? 0;
  const stuck = (counts.pending_scan ?? 0) + (counts.skipped ?? 0);

  return (
    <>
      <h1>Documents</h1>

      {/* The reason this page exists, stated before the list. */}
      {quarantined > 0 || stuck > 0 ? (
        <section className="card" style={{ borderColor: quarantined > 0 ? 'var(--danger, #b3261e)' : undefined }}>
          {quarantined > 0 ? (
            <p>
              <strong>{quarantined} quarantined.</strong> Failed the virus scan — stored, unfileable,
              and not downloadable by anyone. Each one has a task with the SOP for asking the client
              for a replacement.
            </p>
          ) : null}
          {stuck > 0 ? (
            <p className={quarantined > 0 ? 'muted small' : undefined}>
              <strong>{stuck} awaiting a verdict.</strong> The client sent these and can see them, but
              they do not satisfy a document request yet — so those clients are still being chased.
              Clears automatically once the scanner is reachable.
            </p>
          ) : null}
        </section>
      ) : (
        <p className="muted">Nothing quarantined, nothing stuck awaiting a scan.</p>
      )}

      <div className="chips" style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', margin: '0.75rem 0' }}>
        {FILTERS.map((f) => {
          const n = f.key === null
            ? Object.values(counts).reduce((a, b) => a + b, 0)
            : (counts[f.key] ?? 0);
          return (
            <button
              key={f.label}
              type="button"
              className={`btn ghost ${filter === f.key ? 'active' : ''}`}
              onClick={() => setFilter(f.key)}
              aria-pressed={filter === f.key}
            >
              {f.label} ({n})
            </button>
          );
        })}
      </div>

      {error ? (
        <section className="card">
          <p className="alert error">{error}</p>
          <button className="btn" type="button" onClick={() => load(filter)}>
            Try again
          </button>
        </section>
      ) : !data ? (
        <p className="muted">Loading…</p>
      ) : data.documents.length === 0 ? (
        <p className="muted">No documents match this filter.</p>
      ) : (
        <>
          {/* 390px: cards. Each one names the client, because a filename without a
              client is not actionable. */}
          <div className="phone-only">
            {data.documents.map((d) => (
              <section className="card" key={d.id}>
                <div>
                  <strong>{d.filename}</strong>
                </div>
                <div>
                  <Link href={`/clients/${d.contact_id}`}>{d.contact_name ?? 'Unknown client'}</Link>
                  {d.contact_is_test ? <span className="badge"> test</span> : null}
                </div>
                <div className="muted small">
                  {d.category.replaceAll('_', ' ')} · {formatBytes(d.size_bytes)} ·{' '}
                  {new Date(d.created_at).toLocaleDateString()}
                </div>
                <div>
                  <span className={`badge ${SCAN_TONE[d.scan_status] ?? ''}`}>
                    {SCAN_LABEL[d.scan_status] ?? d.scan_status}
                  </span>
                  {d.filing_deferred ? (
                    <span className="badge warn"> filing on hold</span>
                  ) : null}
                </div>
                {d.scan_detail ? <div className="muted small">{d.scan_detail}</div> : null}
              </section>
            ))}
          </div>

          <div className="desk-only">
            <table className="table">
              <thead>
                <tr>
                  <th>File</th>
                  <th>Client</th>
                  <th>Category</th>
                  <th>Scan</th>
                  <th>Uploaded</th>
                </tr>
              </thead>
              <tbody>
                {data.documents.map((d) => (
                  <tr key={d.id}>
                    <td>
                      {d.filename}
                      <div className="muted small">{formatBytes(d.size_bytes)}</div>
                    </td>
                    <td>
                      <Link href={`/clients/${d.contact_id}`}>{d.contact_name ?? 'Unknown'}</Link>
                      {d.contact_is_test ? <span className="badge"> test</span> : null}
                    </td>
                    <td>{d.category.replaceAll('_', ' ')}</td>
                    <td>
                      <span className={`badge ${SCAN_TONE[d.scan_status] ?? ''}`}>
                        {SCAN_LABEL[d.scan_status] ?? d.scan_status}
                      </span>
                      {d.filing_deferred ? <div className="muted small">filing on hold</div> : null}
                      {d.scan_detail ? <div className="muted small">{d.scan_detail}</div> : null}
                    </td>
                    <td>{new Date(d.created_at).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}
