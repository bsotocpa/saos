'use client';

// Settings admin (MP): SLA windows, alert thresholds, automation knobs —
// tuned here, applied on the next job run, zero deploys.

import { useEffect, useState } from 'react';
import { api } from '../../../lib/api';

interface Setting { key: string; value: unknown; description: string | null }

export default function SettingsAdminPage() {
  const [settings, setSettings] = useState<Setting[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [message, setMessage] = useState('');

  const load = async () => {
    const res = await api<{ settings: Setting[] }>('/admin/settings');
    setSettings(res.settings);
  };
  useEffect(() => {
    void load();
  }, []);

  const save = async (key: string) => {
    const raw = drafts[key];
    if (raw === undefined) return;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      value = raw; // plain strings are fine
    }
    await api(`/admin/settings/${key}`, { method: 'PATCH', body: { value } });
    setMessage(`${key} updated (old → new recorded in the audit log).`);
    setDrafts((d) => {
      const next = { ...d };
      delete next[key];
      return next;
    });
    await load();
  };

  return (
    <>
      <h1>Settings</h1>
      {message ? <p className="alert info">{message}</p> : null}
      <section className="card">
        <table>
          <thead><tr><th>Setting</th><th>Value</th><th style={{ width: 80 }} /></tr></thead>
          <tbody>
            {settings.map((s) => (
              <tr key={s.key}>
                <td>
                  <strong className="small">{s.key}</strong>
                  <br />
                  <span className="muted small">{s.description}</span>
                </td>
                <td style={{ width: 260 }}>
                  <input
                    value={drafts[s.key] ?? JSON.stringify(s.value)}
                    onChange={(e) => setDrafts({ ...drafts, [s.key]: e.target.value })}
                  />
                </td>
                <td>
                  {drafts[s.key] !== undefined ? (
                    <button className="btn ghost" type="button" onClick={() => void save(s.key)}>Save</button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}
