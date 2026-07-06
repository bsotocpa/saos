'use client';

// Template admin (MP): ALL client-facing copy, EN + ES, editable with zero
// deploys. PLACEHOLDER templates are unsendable until final legal text lands
// and the flag is cleared — the launch-gate action.

import { useEffect, useState } from 'react';
import { api } from '../../../lib/api';

interface Template {
  key: string; name: string; channel: string;
  subject_en: string | null; subject_es: string | null;
  body_en: string; body_es: string | null;
  is_placeholder: boolean; version: number;
}

export default function TemplatesAdminPage() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [editing, setEditing] = useState<Template | null>(null);
  const [message, setMessage] = useState('');

  const load = async () => {
    const res = await api<{ templates: Template[] }>('/admin/templates');
    setTemplates(res.templates);
  };
  useEffect(() => {
    void load();
  }, []);

  const save = async (clearPlaceholder: boolean) => {
    if (!editing) return;
    const res = await api<{ placeholderCleared: boolean }>(`/admin/templates/${editing.key}`, {
      method: 'PATCH',
      body: {
        subjectEn: editing.subject_en,
        subjectEs: editing.subject_es,
        bodyEn: editing.body_en,
        bodyEs: editing.body_es,
        ...(clearPlaceholder ? { isPlaceholder: false } : {}),
      },
    });
    setMessage(
      res.placeholderCleared
        ? `${editing.key}: final text saved and PLACEHOLDER CLEARED — this template can now send.`
        : `${editing.key} saved (new version).`
    );
    setEditing(null);
    await load();
  };

  return (
    <>
      <h1>Templates</h1>
      <p className="muted small">
        Copy changes never require a deploy. Templates flagged PLACEHOLDER are blocked from sending until final
        text is supplied and the flag is cleared.
      </p>
      {message ? <p className="alert info">{message}</p> : null}

      {editing ? (
        <section className="card" style={{ borderColor: 'var(--electric)' }}>
          <h2>
            {editing.name} {editing.is_placeholder ? <span className="badge danger">PLACEHOLDER</span> : <span className="badge ok">live</span>}
          </h2>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div>
              <label className="field">
                Subject (EN)
                <input value={editing.subject_en ?? ''} onChange={(e) => setEditing({ ...editing, subject_en: e.target.value })} />
              </label>
              <label className="field">
                Body (EN)
                <textarea rows={10} value={editing.body_en} onChange={(e) => setEditing({ ...editing, body_en: e.target.value })} />
              </label>
            </div>
            <div>
              <label className="field">
                Subject (ES)
                <input value={editing.subject_es ?? ''} onChange={(e) => setEditing({ ...editing, subject_es: e.target.value })} />
              </label>
              <label className="field">
                Body (ES)
                <textarea rows={10} value={editing.body_es ?? ''} onChange={(e) => setEditing({ ...editing, body_es: e.target.value })} />
              </label>
            </div>
          </div>
          <p>
            <button className="btn" type="button" onClick={() => void save(false)}>Save</button>{' '}
            {editing.is_placeholder ? (
              <button
                className="btn accent"
                type="button"
                onClick={() => {
                  if (window.confirm('Clear the PLACEHOLDER flag? This confirms the text above is the FINAL legal language — the template becomes sendable to clients.')) {
                    void save(true);
                  }
                }}
              >
                Save as FINAL (clear placeholder)
              </button>
            ) : null}{' '}
            <button className="btn ghost" type="button" onClick={() => setEditing(null)}>Cancel</button>
          </p>
        </section>
      ) : null}

      <section className="card">
        <table>
          <thead><tr><th>Template</th><th>Channel</th><th>Status</th><th>v</th><th /></tr></thead>
          <tbody>
            {templates.map((t) => (
              <tr key={t.key}>
                <td>{t.name}</td>
                <td className="muted small">{t.channel}</td>
                <td>{t.is_placeholder ? <span className="badge danger">PLACEHOLDER</span> : <span className="badge ok">live</span>}</td>
                <td className="muted small">{t.version}</td>
                <td style={{ width: 70 }}>
                  <button className="btn ghost" type="button" onClick={() => setEditing(t)}>Edit</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}
