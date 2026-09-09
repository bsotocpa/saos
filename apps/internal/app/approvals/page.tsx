'use client';

// Session recap approvals (v4.2 #6 — wireframe owner step 3: "your voice, before
// it sends").
//
// One screen, one tap. Both language drafts are shown side by side because the
// Spanish body is generated with Spanish headings but the CONTENT still carries the
// session's own words — so the thing Brian is actually checking is whether the
// Spanish reads right, and hiding it behind a toggle would make that easy to skip.
//
// The panel states whether the send is armed BEFORE the approve button, so the tap
// never silently does nothing.

import { formatDate, formatDateTime, formatTime } from '../../lib/dates';
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, isAuthed } from '../../lib/api';

interface Recap {
  meeting_id: string;
  title: string | null;
  started_at: string | null;
  contact_id: string | null;
  first_name: string | null;
  last_name: string | null;
  language: string | null;
  status: 'drafted' | 'approved';
  recap_body_en: string;
  recap_body_es: string;
  recap_send_suppressed_reason: string | null;
  approved_by: string | null;
  recap_approved_at: string | null;
}

export default function ApprovalsPage() {
  const router = useRouter();
  const [recaps, setRecaps] = useState<Recap[]>([]);
  const [armed, setArmed] = useState(false);
  const [editing, setEditing] = useState<string>('');
  const [draftEn, setDraftEn] = useState('');
  const [draftEs, setDraftEs] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');

  const load = useCallback(async () => {
    try {
      const r = await api<{ recaps: Recap[]; automationArmed: boolean }>('/recaps');
      setRecaps(r.recaps);
      setArmed(r.automationArmed);
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

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    setError('');
    setNote('');
    try {
      await fn();
      setNote(ok);
      setEditing('');
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h1>Approvals</h1>
      {error ? <div className="alert error">{error}</div> : null}
      {note ? <div className="alert ok">{note}</div> : null}

      <div className={armed ? 'alert info' : 'alert warn'}>
        {armed ? (
          <>
            <strong>Recap sending is armed.</strong> Approving posts the recap to the client&apos;s
            portal thread and emails them a pointer to it.
          </>
        ) : (
          <>
            <strong>Recap sending is OFF.</strong> You can approve, and the approval is recorded with
            your name — but nothing reaches the client until you arm{' '}
            <em>Session recaps</em> in Admin → Automations. Approved recaps wait, with the reason shown.
          </>
        )}
      </div>

      {recaps.length === 0 ? (
        <section className="card">
          <p className="muted">
            No recaps waiting. They draft themselves after a session is summarised, then appear here.
          </p>
        </section>
      ) : null}

      {recaps.map((r) => (
        <section className="card" key={r.meeting_id} style={{ marginBottom: 12 }}>
          <h2>
            {r.first_name ? `${r.first_name} ${r.last_name ?? ''}`.trim() : 'Unlinked session'}{' '}
            {r.status === 'approved' ? <span className="badge ok">approved</span> : <span className="badge warn">draft</span>}
            {r.language === 'es' ? <span className="badge">client reads ES</span> : null}
          </h2>
          <p className="muted small">
            {r.title ?? 'untitled session'}
            {r.started_at ? ` · ${formatDate(r.started_at)}` : ''}
            {r.approved_by ? ` · approved by ${r.approved_by}` : ''}
          </p>
          {r.recap_send_suppressed_reason ? (
            <div className="alert warn">
              Approved but not sent — {r.recap_send_suppressed_reason}.
            </div>
          ) : null}

          {editing === r.meeting_id ? (
            <>
              <div className="grid2">
                <label className="field">
                  English
                  <textarea rows={12} value={draftEn} onChange={(e) => setDraftEn(e.target.value)} />
                </label>
                <label className="field">
                  Español
                  <textarea rows={12} value={draftEs} onChange={(e) => setDraftEs(e.target.value)} />
                </label>
              </div>
              <div className="chipbar">
                <button
                  type="button"
                  className="btn accent"
                  disabled={busy || draftEn.trim().length === 0 || draftEs.trim().length === 0}
                  onClick={() =>
                    void act(
                      () => api(`/meetings/${r.meeting_id}/recap`, { method: 'PATCH', body: { bodyEn: draftEn, bodyEs: draftEs } }),
                      'Saved. Editing withdrew the previous approval, so approve again when you are happy.'
                    )
                  }
                >
                  Save edits
                </button>
                <button type="button" className="btn ghost" disabled={busy} onClick={() => setEditing('')}>
                  Cancel
                </button>
              </div>
              <p className="muted small">
                Editing an approved recap withdraws the approval — your name should not stay attached to
                text you have not read.
              </p>
            </>
          ) : (
            <>
              <div className="grid2">
                <div>
                  <h2 style={{ fontSize: 12.5 }}>English</h2>
                  <pre className="recap-body">{r.recap_body_en}</pre>
                </div>
                <div>
                  <h2 style={{ fontSize: 12.5 }}>Español</h2>
                  <pre className="recap-body">{r.recap_body_es}</pre>
                </div>
              </div>
              <div className="chipbar">
                <button
                  type="button"
                  className="btn accent"
                  disabled={busy}
                  onClick={() =>
                    void act(
                      () => api(`/meetings/${r.meeting_id}/recap/approve`, { method: 'POST' }),
                      armed ? 'Approved and sent to the client.' : 'Approved. It will send when you arm Session recaps.'
                    )
                  }
                >
                  {armed ? 'Approve & send' : 'Approve (will not send yet)'}
                </button>
                <button
                  type="button"
                  className="chip"
                  disabled={busy}
                  onClick={() => {
                    setEditing(r.meeting_id);
                    setDraftEn(r.recap_body_en);
                    setDraftEs(r.recap_body_es);
                  }}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className="chip"
                  disabled={busy}
                  onClick={() =>
                    void act(
                      () => api(`/meetings/${r.meeting_id}/recap/draft`, { method: 'POST' }),
                      'Re-drafted from the session summary.'
                    )
                  }
                >
                  Re-draft
                </button>
              </div>
            </>
          )}
        </section>
      ))}
    </>
  );
}
