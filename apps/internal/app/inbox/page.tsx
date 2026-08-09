'use client';

// Unified inbox — quarantined inbound attachments (email/MMS). Accept-never-
// reject policy: everything lands here first; NOTHING reaches a client
// document folder without the confirm tap on this screen. Unmatched senders
// show triage-only (no category suggestion, no filing until assigned).

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, isAuthed } from '../../lib/api';

interface Attachment {
  id: string;
  channel: 'email' | 'mms';
  sender: string;
  filename: string;
  mime_type: string | null;
  size_bytes: number;
  scan_status: 'pending' | 'clean' | 'infected' | 'skipped';
  scan_detail: string | null;
  suggested_category: string | null;
  created_at: string;
  contact_id: string | null;
  contact_name: string | null;
}

const CATEGORIES = [
  'tax_documents', 'business_records', 'id_verification', 'irs_notices', 'signed_authorizations', 'other',
];

function fmtSize(bytes: number): string {
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

export default function InboxPage() {
  const router = useRouter();
  const [items, setItems] = useState<Attachment[]>([]);
  const [error, setError] = useState('');
  const [category, setCategory] = useState<Record<string, string>>({});
  const [assigning, setAssigning] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<{ id: string; name: string }[]>([]);

  const load = useCallback(async () => {
    try {
      const r = await api<{ attachments: Attachment[] }>('/inbound-attachments?status=quarantined');
      setItems(r.attachments);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    if (!isAuthed()) {
      router.replace('/login');
      return;
    }
    void load();
  }, [router, load]);

  const file = async (a: Attachment) => {
    const cat = category[a.id] ?? a.suggested_category;
    if (!cat) { setError('Pick a category first.'); return; }
    setError('');
    try {
      await api(`/inbound-attachments/${a.id}/file`, { method: 'POST', body: { category: cat } });
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const discard = async (id: string) => {
    await api(`/inbound-attachments/${id}/discard`, { method: 'POST', body: {} });
    await load();
  };

  const searchContacts = async (q: string) => {
    if (!q.trim()) { setResults([]); return; }
    const r = await api<{ contacts: { id: string; first_name: string; last_name: string }[] }>(
      `/contacts?search=${encodeURIComponent(q)}&limit=6`
    );
    setResults(r.contacts.map((c) => ({ id: c.id, name: `${c.first_name} ${c.last_name}` })));
  };

  const reassign = async (attachmentId: string, contactId: string) => {
    await api(`/inbound-attachments/${attachmentId}/reassign`, { method: 'POST', body: { contactId } });
    setAssigning(null);
    setSearch('');
    setResults([]);
    await load();
  };

  return (
    <>
      <h1>Inbox — attachments to review</h1>
      {error ? <div className="alert error">{error}</div> : null}
      <p className="muted small">
        Files that arrived by email or text. Nothing reaches a client folder until you confirm it here —
        review, pick the client and category, file or discard.
      </p>
      {items.length === 0 ? (
        <section className="card"><p className="muted">Nothing in quarantine. 🎉</p></section>
      ) : null}
      {items.map((a) => (
        <section className="card" key={a.id} style={{ marginBottom: 10 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'baseline' }}>
            <span className="badge">{a.channel.toUpperCase()}</span>
            <strong style={{ overflowWrap: 'anywhere' }}>{a.filename}</strong>
            <span className="muted small">{fmtSize(a.size_bytes)} · {a.created_at.slice(0, 16).replace('T', ' ')}</span>
            {a.scan_status === 'clean' ? <span className="badge ok">scanned clean</span> : null}
            {a.scan_status === 'skipped' ? <span className="badge warn" title={a.scan_detail ?? ''}>scan skipped</span> : null}
            {a.scan_status === 'infected' ? <span className="badge danger" title={a.scan_detail ?? ''}>INFECTED — cannot file</span> : null}
          </div>
          <p className="small" style={{ margin: '6px 0', overflowWrap: 'anywhere' }}>
            From: {a.contact_name ? <strong>{a.contact_name}</strong> : <span className="badge warn">unmatched sender</span>}
            <span className="muted"> ({a.sender})</span>
            {!a.contact_id ? <span className="muted"> — triage only: assign a client before filing.</span> : null}
          </p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <a className="btn ghost" href={`/api/inbound-attachments/${a.id}/download`} target="_blank" rel="noreferrer">Preview</a>
            <select
              style={{ display: 'inline-block', width: 'auto', margin: 0 }}
              value={category[a.id] ?? a.suggested_category ?? ''}
              onChange={(e) => setCategory((c) => ({ ...c, [a.id]: e.target.value }))}
            >
              <option value="">Category…</option>
              {CATEGORIES.map((c) => <option key={c} value={c}>{c.replace(/_/g, ' ')}{a.suggested_category === c ? ' (suggested)' : ''}</option>)}
            </select>
            <button className="btn" type="button" disabled={!a.contact_id || a.scan_status === 'infected'} onClick={() => void file(a)}>
              File to client folder
            </button>
            <button className="btn ghost" type="button" onClick={() => setAssigning(assigning === a.id ? null : a.id)}>
              {a.contact_id ? 'Reassign' : 'Assign client'}
            </button>
            <button className="btn danger" type="button" onClick={() => void discard(a.id)}>Discard</button>
          </div>
          {assigning === a.id ? (
            <div style={{ marginTop: 8, maxWidth: 420 }}>
              <input
                placeholder="Search contacts…"
                value={search}
                onChange={(e) => { setSearch(e.target.value); void searchContacts(e.target.value); }}
              />
              {results.map((r) => (
                <button key={r.id} className="chip" type="button" style={{ margin: '4px 4px 0 0' }} onClick={() => void reassign(a.id, r.id)}>
                  {r.name}
                </button>
              ))}
            </div>
          ) : null}
        </section>
      ))}
    </>
  );
}
