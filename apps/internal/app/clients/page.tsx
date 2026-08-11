'use client';

// THE CLIENT DIRECTORY (walkthrough finding #2).
//
// /clients/[id] existed as an orphan page for weeks: no nav entry, no list, no
// global search, and the pipeline card that should have led to it was not
// clickable. 426 active clients and no way to reach any of them by name.
//
// Search covers name, BUSINESS name, email and phone — business name because a
// large part of this book bills under a business rather than a person, and the
// migration flagged 35 such clients. Searching only people made them unfindable.
//
// Table on desktop, cards at 390px (CLAUDE.md).

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api, isAuthed } from '../../lib/api';

interface ClientRow {
  id: string;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  soto_status: string;
  hilo_status: string;
  health_score: number | null;
  client_since: string | null;
  is_test: boolean;
  business_name: string | null;
  active_engagements: number;
}

const STATUS_BADGE: Record<string, string> = {
  active: 'ok', lead: '', prospect: '', former: 'warn', none: '',
};

export default function ClientsPage() {
  const router = useRouter();
  const [rows, setRows] = useState<ClientRow[]>([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const LIMIT = 25;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({ limit: String(LIMIT), offset: String(offset) });
    if (search.trim()) params.set('search', search.trim());
    if (status) params.set('sotoStatus', status);
    try {
      const res = await api<{ contacts: ClientRow[]; total: number }>(`/contacts?${params}`);
      setRows(res.contacts);
      setTotal(res.total);
    } catch (err) {
      // PAGE HARDENING. A deploy replaces the container mid-navigation and Caddy
      // returns 502 for a moment; an unhandled rejection here would white-screen
      // the directory instead of saying so. Brian hit exactly this on
      // /clients/[id] during the 2026-08-11 deploy.
      // The internal api helper throws a plain Error with .code/.status attached
      // (ApiError is the portal's class, not this app's).
      setError(err instanceof Error && err.message ? err.message : 'Could not load clients.');
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [search, status, offset]);

  useEffect(() => {
    if (!isAuthed()) {
      router.replace('/login');
      return;
    }
    // Debounced so typing a name does not fire a query per keystroke.
    const handle = setTimeout(() => void load(), 250);
    return () => clearTimeout(handle);
  }, [load, router]);

  const showing = rows.length === 0 ? '0' : `${offset + 1}–${offset + rows.length}`;

  return (
    <>
      <h1>Clients</h1>
      <p className="muted small">
        Search by name, business, email or phone.{' '}
        {total === 1 ? '1 record matches' : `${total} records match`}.
      </p>

      <section className="card">
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label className="field" style={{ flex: '1 1 220px', marginBottom: 0 }}>
            Search
            <input
              value={search}
              onChange={(e) => { setSearch(e.target.value); setOffset(0); }}
              placeholder="Name, business, email, phone"
              autoComplete="off"
            />
          </label>
          <label className="field" style={{ flex: '0 1 160px', marginBottom: 0 }}>
            Soto status
            <select value={status} onChange={(e) => { setStatus(e.target.value); setOffset(0); }}>
              <option value="">All</option>
              <option value="active">Active</option>
              <option value="lead">Lead</option>
              <option value="prospect">Prospect</option>
              <option value="former">Former</option>
              <option value="none">None</option>
            </select>
          </label>
        </div>
      </section>

      {error ? (
        <section className="card">
          <p className="alert error">{error}</p>
          <p className="muted small">
            If a deploy just went out, the page may have fetched a chunk mid-restart. A reload usually clears it.
          </p>
          <p>
            <button className="btn accent" type="button" onClick={() => void load()}>Try again</button>{' '}
            <button className="btn ghost" type="button" onClick={() => window.location.reload()}>Reload the page</button>
          </p>
        </section>
      ) : loading ? (
        <p className="muted">Loading…</p>
      ) : rows.length === 0 ? (
        <section className="card">
          <p className="muted">
            No client matches that. Search covers name, business name, email and phone.
          </p>
        </section>
      ) : (
        <>
          {/* Desktop: table. */}
          <section className="card desk-only">
            <table>
              <thead>
                <tr>
                  <th>Name</th><th>Business</th><th>Contact</th>
                  <th>Status</th><th>Work</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <Link href={`/clients/${r.id}`}>
                        {r.first_name} {r.last_name}
                      </Link>{' '}
                      {r.is_test ? <span className="badge warn">TEST</span> : null}
                    </td>
                    <td className="muted small">{r.business_name ?? '—'}</td>
                    <td className="muted small" style={{ overflowWrap: 'anywhere' }}>
                      {r.email ?? 'no email'}
                      {r.phone ? <><br />{r.phone}</> : null}
                    </td>
                    <td>
                      <span className={`badge ${STATUS_BADGE[r.soto_status] ?? ''}`}>{r.soto_status}</span>
                      {r.hilo_status !== 'none' ? <> <span className="badge">Hilo</span></> : null}
                    </td>
                    <td className="muted small">
                      {r.active_engagements > 0 ? `${r.active_engagements} active` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          {/* 390px: one card per client, the whole card clickable. */}
          <section className="phone-only">
            {rows.map((r) => (
              <Link key={r.id} href={`/clients/${r.id}`} className="card lead-card-link" style={{ display: 'block', marginBottom: 8 }}>
                <strong>{r.first_name} {r.last_name}</strong>{' '}
                {r.is_test ? <span className="badge warn">TEST</span> : null}
                {r.business_name ? (
                  <><br /><span className="small">{r.business_name}</span></>
                ) : null}
                <br />
                <span className="muted small" style={{ overflowWrap: 'anywhere' }}>{r.email ?? 'no email'}</span>
                {r.phone ? <><br /><span className="muted small">{r.phone}</span></> : null}
                <br />
                <span className={`badge ${STATUS_BADGE[r.soto_status] ?? ''}`}>{r.soto_status}</span>
                {r.hilo_status !== 'none' ? <> <span className="badge">Hilo</span></> : null}
                {r.active_engagements > 0 ? (
                  <> <span className="muted small">{r.active_engagements} active</span></>
                ) : null}
              </Link>
            ))}
          </section>

          <section className="card">
            <p className="small" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <button
                className="btn ghost"
                type="button"
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - LIMIT))}
              >
                ← Previous
              </button>
              <span className="muted">Showing {showing} of {total}</span>
              <button
                className="btn ghost"
                type="button"
                disabled={offset + rows.length >= total}
                onClick={() => setOffset(offset + LIMIT)}
              >
                Next →
              </button>
            </p>
          </section>
        </>
      )}
    </>
  );
}
