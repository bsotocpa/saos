'use client';

// Alert Center (MP): the signed-in staffer's notifications; warning/critical
// leadership alerts also push to iPhones via ntfy within a minute.

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, isAuthed } from '../../lib/api';

interface Notification {
  id: string; type: string; severity: string; title: string; body: string | null;
  read_at: string | null; pushed_at: string | null; created_at: string;
}

export default function AlertsPage() {
  const router = useRouter();
  const [items, setItems] = useState<Notification[]>([]);
  // A refused "Mark read" says so beside its button, verbatim (Brian, 2026-09-19, defect 2).
  const [inlineErr, setInlineErr] = useState<{ key: string; message: string } | null>(null);
  const errAt = (key: string) => (inlineErr?.key === key ? <p className="field-error" role="alert">{inlineErr.message}</p> : null);

  const markRead = async (id: string) => {
    setInlineErr(null);
    try {
      await api(`/notifications/${id}/read`, { method: 'POST' });
      await load();
    } catch (err) {
      setInlineErr({ key: id, message: err instanceof Error && err.message ? err.message : 'The request was refused.' });
    }
  };

  const load = async () => {
    const res = await api<{ notifications: Notification[] }>('/notifications');
    setItems(res.notifications);
  };
  useEffect(() => {
    if (!isAuthed()) {
      router.replace('/login');
      return;
    }
    void load();
  }, [router]);

  return (
    <>
      <h1>Alerts</h1>
      <section className="card">
        {items.length === 0 ? <p className="muted">No alerts.</p> : null}
        <table>
          <tbody>
            {items.map((n) => (
              <tr key={n.id} style={{ opacity: n.read_at ? 0.55 : 1 }}>
                <td>
                  <span className={`badge ${n.severity === 'critical' ? 'danger' : n.severity === 'warning' ? 'warn' : ''}`}>
                    {n.severity}
                  </span>
                </td>
                <td>
                  {n.title}
                  {n.pushed_at ? <span className="muted small"> · pushed</span> : null}
                </td>
                <td style={{ width: 90 }}>
                  {!n.read_at ? (
                    <button className="btn ghost" type="button" onClick={() => void markRead(n.id)}>
                      Mark read
                    </button>
                  ) : null}
                  {errAt(n.id)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}
