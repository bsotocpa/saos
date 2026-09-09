'use client';

// SOP knowledge base (M27) — the runs-without-Brian layer.
//
// Reading is the primary job: a new hire lands here from a task's "how to do
// this" link, so search and the body come first and editing is secondary. The
// registry tab is the honest coverage view — how many task types actually have a
// procedure written, not how many have a mapping.

import { formatDate, formatDateTime, formatTime } from '../../lib/dates';
import { Suspense, useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { api, isAuthed } from '../../lib/api';

interface SopRow {
  slug: string;
  title: string;
  role_key: string | null;
  process: string | null;
  status: string;
  version: number;
  from_transcript: boolean;
  published_at: string | null;
}
interface SopDetail extends SopRow {
  body_md: string;
  published_by: string | null;
}
interface Registry {
  entries: Array<{
    taskType: string; sopSlug: string | null; sopTitle: string | null;
    written: boolean; published: boolean; noSopReason: string | null;
  }>;
  total: number;
  withSop: number;
  published: number;
  mappedButUnwritten: number;
  deliberatelyNone: number;
}

/** Minimal markdown: headings, bold, list items, rules. No dependency. */
function renderMd(md: string) {
  return md.split('\n').map((line, i) => {
    const key = `${i}-${line.slice(0, 12)}`;
    if (/^---+$/.test(line.trim())) return <hr key={key} />;
    const bold = (s: string) =>
      s.split(/\*\*(.+?)\*\*/g).map((part, j) => (j % 2 === 1 ? <strong key={j}>{part}</strong> : part));
    if (line.startsWith('## ')) return <h2 key={key} style={{ marginTop: 14 }}>{bold(line.slice(3))}</h2>;
    if (line.startsWith('# ')) return <h2 key={key} style={{ marginTop: 14 }}>{bold(line.slice(2))}</h2>;
    if (line.startsWith('> ')) {
      return (
        <p key={key} className="alert warn" style={{ marginBottom: 8 }}>{bold(line.slice(2))}</p>
      );
    }
    if (/^\d+\.\s/.test(line) || line.startsWith('- ')) {
      return (
        <p key={key} className="small" style={{ margin: '2px 0 2px 14px' }}>
          {bold(line)}
        </p>
      );
    }
    if (line.trim() === '') return <div key={key} style={{ height: 6 }} />;
    return <p key={key} className="small" style={{ margin: '4px 0' }}>{bold(line)}</p>;
  });
}

/**
 * useSearchParams() forces this subtree out of static generation, so it MUST sit
 * inside a Suspense boundary or `next build` fails prerendering /sops. Dev mode
 * does not prerender, which is exactly why this only surfaced at deploy time —
 * the production build is now part of the verification step.
 */
export default function SopsPage() {
  return (
    <Suspense fallback={<p className="muted">Loading…</p>}>
      <SopsBrowser />
    </Suspense>
  );
}

function SopsBrowser() {
  const router = useRouter();
  const params = useSearchParams();
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<SopRow[]>([]);
  const [open, setOpen] = useState<SopDetail | null>(null);
  const [history, setHistory] = useState<Array<{ version: number; note: string | null; changed_by: string | null; created_at: string }>>([]);
  const [registry, setRegistry] = useState<Registry | null>(null);
  const [tab, setTab] = useState<'kb' | 'registry'>('kb');
  const [includeDrafts, setIncludeDrafts] = useState(false);
  const [error, setError] = useState('');

  const search = useCallback(async (query: string, drafts: boolean) => {
    try {
      const r = await api<{ sops: SopRow[] }>(
        `/sops?q=${encodeURIComponent(query)}${drafts ? '&includeDrafts=true' : ''}`
      );
      setRows(r.sops);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  const load = useCallback(async (slug: string) => {
    setError('');
    try {
      const r = await api<{ sop: SopDetail; history: typeof history }>(`/sops/${slug}`);
      setOpen(r.sop);
      setHistory(r.history);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    if (!isAuthed()) {
      router.replace('/login');
      return;
    }
    void search('', false);
    void api<Registry>('/sops/task-types').then(setRegistry).catch(() => {});
    // Deep link from a task's "how to do this" link: /sops?slug=…
    const slug = params.get('slug');
    if (slug) void load(slug);
  }, [router, params, search, load]);

  return (
    <>
      <h1>SOPs</h1>
      {error ? <div className="alert error">{error}</div> : null}

      <div className="viewtabs" style={{ marginBottom: 10 }}>
        <button type="button" className={tab === 'kb' ? 'active' : ''} onClick={() => setTab('kb')}>
          Knowledge base
        </button>
        <button type="button" className={tab === 'registry' ? 'active' : ''} onClick={() => setTab('registry')}>
          Task coverage
        </button>
      </div>

      {tab === 'kb' ? (
        <>
          <section className="card" style={{ marginBottom: 12 }}>
            <label className="field">
              Search procedures
              <input
                type="search"
                value={q}
                placeholder="e.g. escalation call, perfection period, month-end"
                onChange={(e) => {
                  setQ(e.target.value);
                  void search(e.target.value, includeDrafts);
                }}
              />
            </label>
            <label className="field inline-check">
              <input
                type="checkbox"
                checked={includeDrafts}
                onChange={(e) => {
                  setIncludeDrafts(e.target.checked);
                  void search(q, e.target.checked);
                }}
              />
              <span>Include drafts (leadership only — drafts never appear in normal search)</span>
            </label>
          </section>

          {open ? (
            <section className="card" style={{ marginBottom: 12 }}>
              <div className="chipbar">
                <button type="button" className="chip" onClick={() => setOpen(null)}>← Back to list</button>
                <span className="badge">v{open.version}</span>
                {open.status !== 'published' ? <span className="badge warn">{open.status}</span> : null}
                {open.from_transcript ? <span className="badge warn">from a recording</span> : null}
              </div>
              <h2>{open.title}</h2>
              <p className="muted small">
                {open.role_key ? `${open.role_key} · ` : ''}{open.process ?? 'general'}
                {' · '}
                {open.published_by
                  ? `reviewed by ${open.published_by}`
                  : 'NOT yet reviewed by a person — generated skeleton'}
              </p>
              <div>{renderMd(open.body_md)}</div>
              {history.length > 0 ? (
                <>
                  <h2 style={{ marginTop: 14 }}>History</h2>
                  {history.map((h) => (
                    <p key={h.version} className="muted small" style={{ margin: '2px 0' }}>
                      v{h.version} · {formatDate(h.created_at)}
                      {h.changed_by ? ` · ${h.changed_by}` : ''}
                      {h.note ? ` — ${h.note}` : ''}
                    </p>
                  ))}
                </>
              ) : null}
            </section>
          ) : (
            <section className="card">
              {rows.length === 0 ? (
                <p className="muted">
                  {q ? 'Nothing matches. Try fewer words.' : 'No published procedures yet.'}
                </p>
              ) : (
                rows.map((s) => (
                  <div className="lead-card" key={s.slug}>
                    <button
                      type="button"
                      className="chip"
                      style={{ border: 'none', padding: 0, background: 'none', textAlign: 'left' }}
                      onClick={() => void load(s.slug)}
                    >
                      <strong>{s.title}</strong>
                    </button>
                    <br />
                    <span className="muted small">
                      {s.role_key ? `${s.role_key} · ` : ''}{s.process ?? 'general'} · v{s.version}
                      {s.status !== 'published' ? ` · ${s.status}` : ''}
                      {s.from_transcript ? ' · from a recording' : ''}
                    </span>
                  </div>
                ))
              )}
            </section>
          )}
        </>
      ) : (
        <section className="card">
          <h2>Task coverage</h2>
          {registry ? (
            <>
              <p className="small">
                {registry.total} task types · <strong>{registry.published} with a published procedure</strong> ·{' '}
                {registry.deliberatelyNone} deliberately none
                {registry.mappedButUnwritten > 0 ? (
                  <>
                    {' · '}
                    <span className="badge danger">{registry.mappedButUnwritten} mapped but unwritten</span>
                  </>
                ) : null}
              </p>
              <p className="muted small">
                Every task type this system can generate is listed. A build check refuses a new
                task-generating feature that is not registered here — so this list cannot silently fall behind.
              </p>
              {registry.entries.map((e) => (
                <div className="quote-line" key={e.taskType}>
                  <span className="name">
                    <code>{e.taskType}</code>
                  </span>
                  <span className="muted small" style={{ flex: '1 1 100%' }}>
                    {e.sopSlug ? (
                      <>
                        {e.sopTitle ?? e.sopSlug}
                        {e.published ? '' : e.written ? ' — draft' : ' — NOT WRITTEN'}
                      </>
                    ) : (
                      <>No procedure: {e.noSopReason}</>
                    )}
                  </span>
                  <span className="amt">
                    {e.published ? (
                      <span className="badge ok">ok</span>
                    ) : e.sopSlug ? (
                      <span className="badge danger">gap</span>
                    ) : (
                      <span className="badge">n/a</span>
                    )}
                  </span>
                </div>
              ))}
            </>
          ) : (
            <p className="muted">Loading…</p>
          )}
        </section>
      )}
    </>
  );
}
