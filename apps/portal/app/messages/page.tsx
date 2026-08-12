'use client';

// Client messages. One open thread at a time keeps the mental model simple.
//
// ATTACHMENTS (finding #11): clients will try to send files in the conversation
// because that is where they are. So there is an attach control here — but the file
// goes through the SAME upload path as the Documents page, and lands in Documents
// scanned, categorised and filed. A portal upload that happens to start in chat.
//
// The message keeps its own immutable sentence ("[Attached: receipt.pdf]") and a
// reference to the document (Brian's ruling). If the document is later deleted or
// refiled the sentence survives and the link degrades to plain text, so the
// conversation never develops a hole.

import { useEffect, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { useSession } from '../../lib/session';

interface Msg {
  id: string;
  direction: 'inbound' | 'outbound';
  body: string;
  sentAt: string;
  documentId: string | null;
  documentFilename: string | null;
}
interface Thread { id: string; subject: string | null; messages: Msg[] }

/** Same categories the Documents page offers — one list, one vocabulary. */
const CATEGORIES = [
  { value: 'tax_documents', key: 'cat_tax_documents' },
  { value: 'business_records', key: 'cat_business_records' },
  { value: 'id_verification', key: 'cat_id_verification' },
  { value: 'irs_notices', key: 'cat_irs_notices' },
  { value: 'other', key: 'cat_other' },
] as const;

export default function MessagesPage() {
  const { t } = useSession();
  const [threads, setThreads] = useState<Thread[]>([]);
  const [body, setBody] = useState('');
  const [subject, setSubject] = useState('');
  const [busy, setBusy] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [category, setCategory] = useState<string>('tax_documents');
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    const r = await api<{ threads: Thread[] }>('/portal/messages');
    setThreads(r.threads);
  };
  useEffect(() => {
    void load();
  }, []);

  const activeThread = threads[0] ?? null;

  const send = async () => {
    if (!body.trim() && !file) return;
    setBusy(true);
    setError(null);
    try {
      if (file) {
        // The file route also carries the typed note, so one tap sends both and the
        // thread shows one message rather than two.
        const form = new FormData();
        form.append('category', category);
        if (activeThread) form.append('threadId', activeThread.id);
        if (body.trim()) form.append('note', body.trim());
        form.append('file', file);
        await api('/portal/messages/attachments', { method: 'POST', formData: form });
        setFile(null);
      } else {
        await api('/portal/messages', {
          method: 'POST',
          body: { body, ...(activeThread ? { threadId: activeThread.id } : { subject: subject || undefined }) },
        });
      }
      setBody('');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('error_generic'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h1>{t('msg_title')}</h1>
      <p className="muted">{t('msg_intro')}</p>
      <section className="card">
        {activeThread ? (
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {activeThread.messages.map((m) => (
              <div key={m.id} className={`msg ${m.direction}`}>
                <span style={{ whiteSpace: 'pre-wrap' }}>{m.body}</span>
                {/* The body already names the file. The link is a bonus that
                    disappears cleanly if the document moved. */}
                {m.documentId ? (
                  <div>
                    <a
                      href={`/api/portal/documents/${m.documentId}/download`}
                      className="small"
                    >
                      {t('msg_open_attachment')}
                      {m.documentFilename ? ` — ${m.documentFilename}` : ''}
                    </a>
                  </div>
                ) : null}
                <div className="muted small">{new Date(m.sentAt).toLocaleString()}</div>
              </div>
            ))}
          </div>
        ) : (
          <label className="field">
            {t('msg_new_subject')}
            <input value={subject} onChange={(e) => setSubject(e.target.value)} />
          </label>
        )}

        <label className="field">
          <textarea
            rows={3}
            placeholder={t('msg_placeholder')}
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
        </label>

        {/* ATTACH. Deliberately says where the file goes — a client sending a W-2
            in chat should know it lands in their documents, not in a chat log. */}
        <label className="field">
          {t('msg_attach_label')}
          <input
            type="file"
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null);
              setError(null);
            }}
          />
        </label>
        {file ? (
          <>
            <label className="field">
              {t('msg_attach_category')}
              <select value={category} onChange={(e) => setCategory(e.target.value)}>
                {CATEGORIES.map((c) => (
                  <option key={c.value} value={c.value}>{t(c.key)}</option>
                ))}
              </select>
            </label>
            <p className="muted small">{t('msg_attach_where')}</p>
          </>
        ) : null}

        {error ? <p className="alert error">{error}</p> : null}

        <button
          className="btn"
          type="button"
          disabled={busy || (!body.trim() && !file)}
          onClick={() => void send()}
        >
          {busy ? t('msg_sending') : file ? t('msg_send_with_file') : t('msg_send')}
        </button>
      </section>
    </>
  );
}
