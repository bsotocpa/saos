'use client';

// Client announcements (M27). Compose → preview the audience → submit → someone
// else approves → send.
//
// The suppression preview is shown BEFORE the approval step on purpose. Whoever
// approves a bulk client send should see "88 of 426 will be suppressed: opted
// out" while deciding, not discover it afterwards in a run record.

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, isAuthed } from '../../lib/api';

interface Preview {
  intended: number;
  emailable: number;
  smsable: number;
  suppressed: Array<{ reason: string; count: number }>;
}

interface BroadcastRow {
  id: string;
  name: string;
  channel: string;
  status: string;
  intended_count: number;
  sent_count: number;
  suppressed_count: number;
  created_by: string | null;
  approved_by: string | null;
  sent_at: string | null;
  created_at: string;
}

const STATUS_BADGE: Record<string, string> = {
  draft: '',
  pending_approval: 'warn',
  approved: 'ok',
  sending: 'warn',
  sent: 'ok',
  cancelled: 'danger',
};

export default function AnnouncementsPage() {
  const router = useRouter();
  const [list, setList] = useState<BroadcastRow[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);

  const [name, setName] = useState('');
  const [channel, setChannel] = useState<'email' | 'sms' | 'both'>('email');
  const [status, setStatus] = useState('');
  const [language, setLanguage] = useState('');
  const [serviceLine, setServiceLine] = useState('');
  const [subjectEn, setSubjectEn] = useState('');
  const [subjectEs, setSubjectEs] = useState('');
  const [bodyEn, setBodyEn] = useState('');
  const [bodyEs, setBodyEs] = useState('');
  const [smsEn, setSmsEn] = useState('');
  const [smsEs, setSmsEs] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);

  const segment = {
    ...(status ? { sotoStatus: status } : {}),
    ...(language ? { language } : {}),
    ...(serviceLine ? { serviceLine } : {}),
  };

  const load = useCallback(async () => {
    try {
      setList((await api<{ broadcasts: BroadcastRow[] }>('/broadcasts')).broadcasts);
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

  const runPreview = async () => {
    setError('');
    try {
      setPreview(await api<Preview>('/broadcasts/preview', { method: 'POST', body: { segment, channel } }));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const act = async (id: string, action: 'submit' | 'approve' | 'send' | 'cancel') => {
    setBusy(true);
    setError('');
    try {
      await api(`/broadcasts/${id}/${action}`, { method: 'POST' });
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const create = async () => {
    setBusy(true);
    setError('');
    try {
      await api('/broadcasts', {
        method: 'POST',
        body: {
          name, channel, segment,
          ...(channel !== 'sms' ? { subjectEn, subjectEs } : {}),
          bodyEn: bodyEn || '—', bodyEs: bodyEs || '—',
          ...(channel !== 'email' ? { smsEn, smsEs } : {}),
        },
      });
      setOpen(false);
      setName(''); setSubjectEn(''); setSubjectEs(''); setBodyEn(''); setBodyEs('');
      setSmsEn(''); setSmsEs(''); setPreview(null);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h1>Announcements</h1>
      {error ? <div className="alert error">{error}</div> : null}

      <div className="alert info">
        Nothing here sends itself. A draft goes for approval, and someone other than its author has to
        approve it. Every announcement email carries an unsubscribe link and every SMS a STOP line —
        appended at send, so they cannot be edited out of the copy.
      </div>

      <div className="chipbar">
        <button type="button" className="btn accent" onClick={() => setOpen((o) => !o)}>
          {open ? 'Close composer' : 'New announcement'}
        </button>
      </div>

      {open ? (
        <section className="card span" style={{ marginBottom: 12 }}>
          <h2>Compose</h2>
          <label className="field">
            Internal name (not shown to clients)
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. January document window" />
          </label>
          <div className="grid2">
            <label className="field">
              Channel
              <select value={channel} onChange={(e) => setChannel(e.target.value as 'email' | 'sms' | 'both')}>
                <option value="email">Email</option>
                <option value="sms">SMS</option>
                <option value="both">Both</option>
              </select>
            </label>
            <label className="field">
              Audience — status
              <select value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="">Everyone</option>
                <option value="active">Active clients</option>
                <option value="lead">Leads</option>
                <option value="former">Former clients</option>
              </select>
            </label>
            <label className="field">
              Audience — language
              <select value={language} onChange={(e) => setLanguage(e.target.value)}>
                <option value="">Both languages</option>
                <option value="en">English only</option>
                <option value="es">Spanish only</option>
              </select>
            </label>
            <label className="field">
              Audience — active service
              <select value={serviceLine} onChange={(e) => setServiceLine(e.target.value)}>
                <option value="">Any service</option>
                {['tax', 'bookkeeping', 'payroll', 'sales_tax', 'advisory', 'coo', 'entity', 'nonprofit_cfo'].map((s) => (
                  <option key={s} value={s}>{s.replaceAll('_', ' ')}</option>
                ))}
              </select>
            </label>
          </div>

          <div className="chipbar">
            <button type="button" className="btn ghost" onClick={() => void runPreview()}>
              Preview audience
            </button>
          </div>
          {preview ? (
            <div className="alert info">
              <strong>{preview.intended} in the segment</strong> · {preview.emailable} emailable ·{' '}
              {preview.smsable} textable
              {preview.suppressed.length > 0 ? (
                <>
                  <br />
                  Suppressed: {preview.suppressed.map((s) => `${s.count} ${s.reason}`).join(' · ')}
                </>
              ) : (
                <>
                  <br />
                  Nobody suppressed.
                </>
              )}
            </div>
          ) : null}

          {channel !== 'sms' ? (
            <>
              <div className="grid2">
                <label className="field">
                  Subject (EN)
                  <input value={subjectEn} onChange={(e) => setSubjectEn(e.target.value)} />
                </label>
                <label className="field">
                  Subject (ES)
                  <input value={subjectEs} onChange={(e) => setSubjectEs(e.target.value)} />
                </label>
              </div>
              <div className="grid2">
                <label className="field">
                  Body (EN) — {'{{first_name}}'} is available
                  <textarea rows={5} value={bodyEn} onChange={(e) => setBodyEn(e.target.value)} />
                </label>
                <label className="field">
                  Body (ES)
                  <textarea rows={5} value={bodyEs} onChange={(e) => setBodyEs(e.target.value)} />
                </label>
              </div>
            </>
          ) : null}
          {channel !== 'email' ? (
            <div className="grid2">
              <label className="field">
                SMS (EN) — STOP line is appended
                <textarea rows={3} value={smsEn} onChange={(e) => setSmsEn(e.target.value)} />
              </label>
              <label className="field">
                SMS (ES)
                <textarea rows={3} value={smsEs} onChange={(e) => setSmsEs(e.target.value)} />
              </label>
            </div>
          ) : null}

          <button type="button" className="btn accent" disabled={busy || name.trim().length < 3} onClick={() => void create()}>
            Save draft
          </button>
        </section>
      ) : null}

      {list.length === 0 ? (
        <section className="card"><p className="muted">No announcements yet.</p></section>
      ) : (
        list.map((b) => (
          <section className="card" key={b.id} style={{ marginBottom: 10 }}>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-start' }}>
              <span style={{ flex: 1, minWidth: 200 }}>
                <strong>{b.name}</strong>{' '}
                <span className={`badge ${STATUS_BADGE[b.status] ?? ''}`}>{b.status.replaceAll('_', ' ')}</span>{' '}
                <span className="badge">{b.channel}</span>
                <br />
                <span className="muted small">
                  by {b.created_by ?? 'unknown'}
                  {b.approved_by ? ` · approved by ${b.approved_by}` : ' · not yet approved'}
                  {b.status === 'sent'
                    ? ` · ${b.sent_count} sent, ${b.suppressed_count} suppressed of ${b.intended_count}`
                    : ''}
                </span>
              </span>
              <span className="chipbar" style={{ marginBottom: 0 }}>
                {b.status === 'draft' ? (
                  <button type="button" className="chip" disabled={busy} onClick={() => void act(b.id, 'submit')}>
                    Submit for approval
                  </button>
                ) : null}
                {b.status === 'pending_approval' ? (
                  <button type="button" className="chip" disabled={busy} onClick={() => void act(b.id, 'approve')}>
                    Approve
                  </button>
                ) : null}
                {b.status === 'approved' ? (
                  <button type="button" className="btn accent" disabled={busy} onClick={() => void act(b.id, 'send')}>
                    Send now
                  </button>
                ) : null}
                {['draft', 'pending_approval', 'approved'].includes(b.status) ? (
                  <button type="button" className="chip" disabled={busy} onClick={() => void act(b.id, 'cancel')}>
                    Cancel
                  </button>
                ) : null}
              </span>
            </div>
          </section>
        ))
      )}
    </>
  );
}
