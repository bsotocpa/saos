'use client';

// Client-acting automation kill switches. Everything here SENDS TO CLIENTS,
// so everything ships OFF: Brian arms each one deliberately as real clients
// reach the portal. Internal alerts and tasks keep running either way — only
// the outbound client message is suppressed (and counted in the job's run
// record so you can see what would have gone out).

import { dayOf, formatDate, formatDateTime, formatTime } from '../../../lib/dates';
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, isAuthed } from '../../../lib/api';
import { useAsk } from '../../../components/ask';

interface Automation {
  key: string;
  name: string;
  description: string;
  audience: 'client' | 'internal';
  enabled: boolean;
  updated_at: string;
  updated_by: string | null;
  /** Sends this automation held while it was off. Arming never replays them (decision 3). */
  held_count: number;
}

export default function AutomationsPage() {
  const router = useRouter();
  const ask = useAsk();
  const [items, setItems] = useState<Automation[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api<{ automations: Automation[] }>('/admin/automations');
      setItems(r.automations);
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

  const toggle = async (a: Automation) => {
    const next = !a.enabled;
    if (next && !(await ask({
      title: `Arm "${a.name}"?`,
      body: <p>This starts sending to real clients on the next job run. What it held while off stays held.</p>,
      choices: [{ key: 'arm', label: 'Arm', tone: 'danger' }],
    }))) return;
    setBusy(a.key);
    setError('');
    try {
      await api(`/admin/automations/${a.key}`, { method: 'PATCH', body: { enabled: next } });
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const armed = items.filter((a) => a.enabled).length;

  return (
    <>
      <h1>Client automations</h1>
      {error ? <div className="alert error">{error}</div> : null}
      <div className="alert info">
        These automations <strong>send messages to clients</strong>. All ship OFF — arm each one when
        you&apos;re ready for it to reach real people. While OFF, the work still surfaces internally
        (tasks, alerts, A/R status) and each job records how many sends it suppressed. Arming does
        <strong> not</strong> replay what was held: a held send stays held, counted on its row and
        recorded on its invoice&apos;s send log, for a person to resend by hand if it should still go.
      </div>
      <p className="muted small">{armed} of {items.length} armed.</p>

      {items.map((a) => (
        <section className="card" key={a.key} style={{ marginBottom: 10 }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <span style={{ flex: 1, minWidth: 220 }}>
              <strong>{a.name}</strong>{' '}
              {a.enabled
                ? <span className="badge ok">ARMED</span>
                : <span className="badge">off</span>}
              {a.held_count > 0 ? (
                <span className="badge warn" title="Sends held while this was off. Arming does not replay them — they stay held; each one is on its invoice's send log.">
                  {a.held_count} held
                </span>
              ) : null}
              <br />
              <span className="muted small" style={{ overflowWrap: 'anywhere' }}>{a.description}</span>
              <br />
              <span className="muted small">
                <code>{a.key}</code>
                {a.updated_by ? ` · last changed by ${a.updated_by} ${dayOf(a.updated_at)}` : ' · never changed'}
              </span>
            </span>
            <button
              className={a.enabled ? 'btn danger' : 'btn'}
              type="button"
              disabled={busy === a.key}
              onClick={() => void toggle(a)}
            >
              {a.enabled ? 'Turn OFF' : 'Arm'}
            </button>
          </div>
        </section>
      ))}
      {items.length === 0 && !error ? <p className="muted">Loading…</p> : null}
    </>
  );
}
