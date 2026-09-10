'use client';

// Template admin (MP): ALL client-facing copy, EN + ES, editable with zero
// deploys. PLACEHOLDER templates are unsendable until final legal text lands
// and the flag is cleared — the launch-gate action.
//
// Legal package v3 added two things this page has to show honestly:
//  · KIND — the Master, Schedules A–E, and the §7216 consents are not peers of
//    an SMS reminder, and retired letters must look retired rather than missing.
//  · SPANISH APPROVAL — "English controls" means a translation is not live copy
//    until Brian approves it, and editing an approved one sends it back.

import { useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import { useAsk } from '../../../components/ask';

interface Template {
  key: string; name: string; channel: string;
  subject_en: string | null; subject_es: string | null;
  body_en: string; body_es: string | null;
  is_placeholder: boolean; version: number;
  kind: 'master' | 'schedule' | 'consent' | 'operational';
  schedule_code: string | null;
  is_active: boolean;
  retired_reason: string | null;
  needs_es_review: boolean;
  es_approved_at: string | null;
}

const KIND_LABEL: Record<Template['kind'], string> = {
  master: 'Master Agreement',
  schedule: 'Service Schedule',
  consent: '§7216 consent',
  operational: 'Operational copy',
};

function kindBadge(t: Template) {
  if (t.kind === 'operational') return null;
  const label = t.kind === 'schedule' ? `Schedule ${t.schedule_code}` : KIND_LABEL[t.kind];
  return <span className="badge">{label}</span>;
}

/** What state the Spanish copy is in — the answer to "can a Spanish client see this?" */
function spanishState(t: Template): { badge: string; className: string; note: string } {
  if (!t.body_es) {
    return {
      badge: 'no Spanish', className: 'badge warn',
      note: 'Spanish readers receive the English text, which is the text that controls.',
    };
  }
  if (t.needs_es_review) {
    return {
      badge: 'awaiting your approval', className: 'badge danger',
      note: 'A translation exists but is NOT being sent. English is used until you approve it.',
    };
  }
  return { badge: 'approved', className: 'badge ok', note: 'Spanish clients receive the Spanish text.' };
}

export default function TemplatesAdminPage() {
  const ask = useAsk();
  const [templates, setTemplates] = useState<Template[]>([]);
  const [editing, setEditing] = useState<Template | null>(null);
  const [message, setMessage] = useState('');
  const [showRetired, setShowRetired] = useState(false);

  const load = async () => {
    const res = await api<{ templates: Template[] }>('/admin/templates');
    setTemplates(res.templates);
  };
  useEffect(() => {
    void load();
  }, []);

  const save = async (clearPlaceholder: boolean) => {
    if (!editing) return;
    const original = templates.find((t) => t.key === editing.key);
    const esChanged =
      (editing.body_es ?? null) !== (original?.body_es ?? null) ||
      (editing.subject_es ?? null) !== (original?.subject_es ?? null);
    const res = await api<{ placeholderCleared: boolean; esRequeuedForApproval: boolean }>(
      `/admin/templates/${editing.key}`,
      {
        method: 'PATCH',
        body: {
          subjectEn: editing.subject_en,
          subjectEs: editing.subject_es,
          bodyEn: editing.body_en,
          bodyEs: editing.body_es,
          ...(clearPlaceholder ? { isPlaceholder: false } : {}),
        },
      }
    );
    const parts = [
      res.placeholderCleared
        ? `${editing.key}: final text saved and PLACEHOLDER CLEARED — this template can now send.`
        : `${editing.key} saved (new version).`,
    ];
    if (res.esRequeuedForApproval && esChanged) {
      parts.push('The Spanish copy is queued for your approval and is not being sent yet.');
    }
    setMessage(parts.join(' '));
    setEditing(null);
    await load();
  };

  const approveSpanish = async (t: Template) => {
    if (!(await ask({
      title: `Approve the Spanish copy for "${t.name}"?`,
      body: <p>This confirms you have READ the translation and it says what the English says. Spanish-language clients will receive it from now on.</p>,
      choices: [{ key: 'approve', label: 'Approve Spanish', tone: 'primary' }],
    }))) return;
    await api(`/admin/templates/${t.key}/es-approve`, { method: 'POST' });
    setMessage(`${t.key}: Spanish approved — Spanish clients now receive the Spanish text.`);
    await load();
  };

  const active = templates.filter((t) => t.is_active);
  const retired = templates.filter((t) => !t.is_active);
  const legal = active.filter((t) => t.kind !== 'operational');
  const operational = active.filter((t) => t.kind === 'operational');
  const awaitingEs = active.filter((t) => t.needs_es_review);
  const placeholders = active.filter((t) => t.is_placeholder);

  const row = (t: Template) => {
    const es = spanishState(t);
    return (
      <tr key={t.key} style={t.is_placeholder ? { background: 'rgba(255,0,0,0.04)' } : undefined}>
        <td>
          {t.name} {kindBadge(t)}
          <div className="muted small">{t.key}</div>
        </td>
        <td className="muted small">{t.channel}</td>
        <td>{t.is_placeholder ? <span className="badge danger">PLACEHOLDER</span> : <span className="badge ok">live</span>}</td>
        <td title={es.note}><span className={es.className}>{es.badge}</span></td>
        <td className="muted small">{t.version}</td>
        <td style={{ width: 190 }}>
          <button className="btn ghost" type="button" onClick={() => setEditing(t)}>Edit</button>{' '}
          {t.needs_es_review && t.body_es ? (
            <button className="btn accent" type="button" onClick={() => void approveSpanish(t)}>
              Approve ES
            </button>
          ) : null}
        </td>
      </tr>
    );
  };

  const table = (rows: Template[]) => (
    <table>
      <thead>
        <tr><th>Template</th><th>Channel</th><th>Status</th><th>Spanish</th><th>v</th><th /></tr>
      </thead>
      <tbody>{rows.map(row)}</tbody>
    </table>
  );

  return (
    <>
      <h1>Templates</h1>
      <p className="muted small">
        Copy changes never require a deploy. Templates flagged PLACEHOLDER are blocked from sending until final
        text is supplied and the flag is cleared.
      </p>
      {message ? <p className="alert info">{message}</p> : null}

      {placeholders.length === 0 ? (
        <p className="alert ok">
          <strong>Legal gate: CLEARED.</strong> No active template is a placeholder — every piece of client-facing
          copy is final text and sendable.
        </p>
      ) : (
        <p className="alert warn">
          <strong>{placeholders.length}</strong> active template{placeholders.length === 1 ? '' : 's'} still flagged
          PLACEHOLDER and blocked from sending: {placeholders.map((t) => t.key).join(', ')}.
        </p>
      )}

      {awaitingEs.length > 0 ? (
        <p className="alert info">
          <strong>{awaitingEs.length}</strong> template{awaitingEs.length === 1 ? '' : 's'} awaiting your Spanish
          approval. English controls until you approve — Spanish-language clients receive the English text in the
          meantime, and nothing is blocked. {awaitingEs.filter((t) => !t.body_es).length > 0 ? (
            <>
              {' '}
              {awaitingEs.filter((t) => !t.body_es).length} of them have no translation entered yet.
            </>
          ) : null}
        </p>
      ) : null}

      {editing ? (
        <section className="card" style={{ borderColor: 'var(--electric)' }}>
          <h2>
            {editing.name} {kindBadge(editing)}{' '}
            {editing.is_placeholder ? <span className="badge danger">PLACEHOLDER</span> : <span className="badge ok">live</span>}
          </h2>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div>
              <label className="field">
                Subject (EN)
                <input value={editing.subject_en ?? ''} onChange={(e) => setEditing({ ...editing, subject_en: e.target.value })} />
              </label>
              <label className="field">
                Body (EN) — the controlling text
                <textarea rows={14} value={editing.body_en} onChange={(e) => setEditing({ ...editing, body_en: e.target.value })} />
              </label>
            </div>
            <div>
              <label className="field">
                Subject (ES)
                <input value={editing.subject_es ?? ''} onChange={(e) => setEditing({ ...editing, subject_es: e.target.value })} />
              </label>
              <label className="field">
                Body (ES)
                <textarea rows={14} value={editing.body_es ?? ''} onChange={(e) => setEditing({ ...editing, body_es: e.target.value })} />
              </label>
              <p className="muted small">
                {spanishState(editing).note} Editing the Spanish text puts it back in the approval queue — an
                approval belongs to the text you read, not to the template.
              </p>
            </div>
          </div>
          <p>
            <button className="btn" type="button" onClick={() => void save(false)}>Save</button>{' '}
            {editing.is_placeholder ? (
              <button
                className="btn accent"
                type="button"
                onClick={async () => {
                  const a = await ask({
                    title: 'Clear the PLACEHOLDER flag?',
                    body: <p>This confirms the text above is the FINAL legal language — the template becomes sendable to clients.</p>,
                    choices: [{ key: 'final', label: 'Save as FINAL', tone: 'danger' }],
                  });
                  if (a) void save(true);
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
        <h2>Legal documents</h2>
        <p className="muted small">
          One Master Engagement Agreement plus Service Schedules A–E. A client signs the Master once; the schedules
          attached at signing are covered by that signature, and services added later are accepted per-schedule in
          the portal.
        </p>
        {table(legal)}
      </section>

      <section className="card">
        <h2>Operational copy</h2>
        {table(operational)}
      </section>

      {retired.length > 0 ? (
        <section className="card">
          <h2>
            Retired ({retired.length}){' '}
            <button className="btn ghost" type="button" onClick={() => setShowRetired(!showRetired)}>
              {showRetired ? 'Hide' : 'Show'}
            </button>
          </h2>
          <p className="muted small">
            Kept, not deleted — these are the terms a past engagement was signed under.
          </p>
          {showRetired ? (
            <table>
              <thead><tr><th>Template</th><th>Why it was retired</th></tr></thead>
              <tbody>
                {retired.map((t) => (
                  <tr key={t.key}>
                    <td>{t.name}<div className="muted small">{t.key}</div></td>
                    <td className="muted small">{t.retired_reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </section>
      ) : null}
    </>
  );
}
