'use client';

// Messages (MP): one threaded conversation history — texts and emails join it
// in Phase 2 via the unified inbox; portal messages live here now.

import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { useSession } from '../../lib/session';

interface Msg { id: string; direction: 'inbound' | 'outbound'; body: string; sentAt: string }
interface Thread { id: string; subject: string | null; messages: Msg[] }

export default function MessagesPage() {
  const { t } = useSession();
  const [threads, setThreads] = useState<Thread[]>([]);
  const [body, setBody] = useState('');
  const [subject, setSubject] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const r = await api<{ threads: Thread[] }>('/portal/messages');
    setThreads(r.threads);
  };
  useEffect(() => {
    void load();
  }, []);

  const activeThread = threads[0] ?? null;

  const send = async () => {
    if (!body.trim()) return;
    setBusy(true);
    try {
      await api('/portal/messages', {
        method: 'POST',
        body: { body, ...(activeThread ? { threadId: activeThread.id } : { subject: subject || undefined }) },
      });
      setBody('');
      await load();
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
                {m.body}
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
        <button className="btn" type="button" disabled={busy || !body.trim()} onClick={() => void send()}>
          {t('msg_send')}
        </button>
      </section>
    </>
  );
}
