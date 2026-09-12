'use client';

// Staff + permissions admin (M4 endpoints). Role changes land in the audit
// log as permission.change; deactivation revokes live sessions immediately.
//
// THE PASSWORD REVEAL (Brian, 2026-09-12). A temporary password is shown exactly once, to the
// admin who minted it, in this page's state, with a copy control, and then it is gone: it is
// not in the staff list, not in any later response, not in a report. Regenerating one is a
// separate, audited action. Names and the sign-in address are editable here so the audit row
// for a correction carries the person who made it.

import { useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import { useAsk } from '../../../components/ask';

interface Staff {
  id: string; full_name: string; legal_name: string; display_name: string; email: string; role: string;
  is_active: boolean; totp_enabled: boolean; last_login_at: string | null; must_change_password: boolean;
}
interface Role { key: string; name: string; permissions: string[] }
interface Reveal { password: string; whose: string; how: 'created' | 'regenerated' }
interface EditDraft { legalName: string; displayName: string; email: string }

export default function StaffAdminPage() {
  const [staff, setStaff] = useState<Staff[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [form, setForm] = useState({ email: '', legalName: '', displayName: '', roleKey: 'intern' });
  const [reveal, setReveal] = useState<Reveal | null>(null);
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<EditDraft>({ legalName: '', displayName: '', email: '' });
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const ask = useAsk();

  const load = async () => {
    const [s, r] = await Promise.all([
      api<{ staff: Staff[] }>('/staff'),
      api<{ roles: Role[] }>('/admin/roles'),
    ]);
    setStaff(s.staff);
    setRoles(r.roles);
  };
  useEffect(() => {
    void load();
  }, []);

  const act = async (fn: () => Promise<void>) => {
    setError('');
    try {
      await fn();
    } catch (err) {
      setError((err as Error).message || 'request failed');
    }
  };

  const copyPassword = async () => {
    if (!reveal) return;
    try {
      await navigator.clipboard.writeText(reveal.password);
      setCopied(true);
    } catch {
      setError('The browser refused the clipboard. Select the password and copy it by hand.');
    }
  };

  const startEdit = (s: Staff) => {
    setEditing(s.id);
    setDraft({ legalName: s.legal_name, displayName: s.display_name, email: s.email });
  };

  const saveEdit = (s: Staff) => act(async () => {
    const body: Partial<EditDraft> = {};
    if (draft.legalName.trim() && draft.legalName !== s.legal_name) body.legalName = draft.legalName.trim();
    if (draft.displayName.trim() && draft.displayName !== s.display_name) body.displayName = draft.displayName.trim();
    if (draft.email.trim() && draft.email.toLowerCase() !== s.email.toLowerCase()) body.email = draft.email.trim();
    if (Object.keys(body).length === 0) { setEditing(null); return; }
    await api(`/staff/${s.id}`, { method: 'PATCH', body });
    const what = [body.legalName || body.displayName ? 'name' : '', body.email ? 'sign-in address' : ''].filter(Boolean).join(' and ');
    const sessionNote = body.email ? '; their open session stays signed in and the next sign-in uses the new address' : '';
    setMessage(`${s.display_name}: ${what} updated (audited${sessionNote}).`);
    setEditing(null);
    await load();
  });

  return (
    <>
      <h1>Staff &amp; permissions</h1>
      {message ? <p className="alert info">{message}</p> : null}
      {error ? <p className="alert danger">{error}</p> : null}
      {reveal ? (
        <section className="card" aria-live="polite" data-testid="temp-password-reveal">
          <h2>Temporary password for {reveal.whose}</h2>
          <p className="muted small">
            Shown once, to you, now. Hand it over out-of-band, never by email. It dies at 72 hours or first use.
            {reveal.how === 'regenerated' ? ' The old password and every open session are already dead.' : ''}
            {' '}MFA enrollment is forced on their first sign-in.
          </p>
          <p>
            <code style={{ fontSize: 18, userSelect: 'all' }}>{reveal.password}</code>
          </p>
          <p style={{ display: 'flex', gap: 8 }}>
            <button className="btn" type="button" onClick={() => void copyPassword()}>{copied ? 'Copied' : 'Copy'}</button>
            <button className="btn ghost" type="button" onClick={() => { setReveal(null); setCopied(false); }}>I have handed it over</button>
          </p>
        </section>
      ) : null}

      <div className="cards">
        <section className="card">
          <h2>Team</h2>
          <table>
            <thead><tr><th>Name</th><th>Role</th><th>MFA</th><th>Status</th><th /></tr></thead>
            <tbody>
              {staff.map((s) => (
                <tr key={s.id}>
                  <td>
                    {editing === s.id ? (
                      <div style={{ display: 'grid', gap: 6 }}>
                        <input aria-label="Legal name" value={draft.legalName} onChange={(e) => setDraft({ ...draft, legalName: e.target.value })} placeholder="Legal name" />
                        <input aria-label="Display name" value={draft.displayName} onChange={(e) => setDraft({ ...draft, displayName: e.target.value })} placeholder="Display name" />
                        <input aria-label="Sign-in email" type="email" value={draft.email} onChange={(e) => setDraft({ ...draft, email: e.target.value })} placeholder="Sign-in email" />
                        <span style={{ display: 'flex', gap: 6 }}>
                          <button className="btn" type="button" onClick={() => void saveEdit(s)}>Save</button>
                          <button className="btn ghost" type="button" onClick={() => setEditing(null)}>Cancel</button>
                        </span>
                      </div>
                    ) : (
                      <>
                        {s.display_name}
                        {s.legal_name !== s.display_name ? <span className="muted small"> ({s.legal_name})</span> : null}
                        <br /><span className="muted small">{s.email}</span>
                        {s.must_change_password ? <><br /><span className="badge warn">owes a password</span></> : null}
                      </>
                    )}
                  </td>
                  <td>
                    <select
                      value={s.role}
                      onChange={(e) => act(async () => {
                        await api(`/staff/${s.id}`, { method: 'PATCH', body: { roleKey: e.target.value } });
                        setMessage(`${s.display_name} → ${e.target.value} (audited as permission.change).`);
                        await load();
                      })}
                    >
                      {roles.map((r) => (
                        <option key={r.key} value={r.key}>{r.key}</option>
                      ))}
                    </select>
                  </td>
                  <td>{s.totp_enabled ? <span className="badge ok">on</span> : <span className="badge warn">pending</span>}</td>
                  <td>{s.is_active ? <span className="badge ok">active</span> : <span className="badge danger">off</span>}</td>
                  <td style={{ width: 180 }}>
                    <div style={{ display: 'grid', gap: 4 }}>
                      <button className="btn ghost" type="button" onClick={() => (editing === s.id ? setEditing(null) : startEdit(s))}>
                        {editing === s.id ? 'Close' : 'Edit'}
                      </button>
                      <button
                        className="btn ghost"
                        type="button"
                        disabled={!s.is_active}
                        onClick={() => act(async () => {
                          const go = await ask({
                            title: `Issue ${s.display_name} a new temporary password?`,
                            body: <p>The current password and every open session die immediately. This is audited.</p>,
                            choices: [{ key: 'go', label: 'Issue a new password', tone: 'danger' }],
                          });
                          if (!go) return;
                          const res = await api<{ tempPassword: string }>(`/staff/${s.id}/password/regenerate`, { method: 'POST' });
                          setCopied(false);
                          setReveal({ password: res.tempPassword, whose: s.display_name, how: 'regenerated' });
                          setMessage('');
                          await load();
                        })}
                      >
                        New temp password
                      </button>
                      <button
                        className="btn ghost"
                        type="button"
                        onClick={() => act(async () => {
                          await api(`/staff/${s.id}`, { method: 'PATCH', body: { isActive: !s.is_active } });
                          await load();
                        })}
                      >
                        {s.is_active ? 'Deactivate' : 'Reactivate'}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="card">
          <h2>Add staff</h2>
          <label className="field">
            Legal name
            <input value={form.legalName} onChange={(e) => setForm({ ...form, legalName: e.target.value })} placeholder="Legal name (contracts, anything client-facing)" />
          </label>
          <label className="field">
            Display name
            <input value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} placeholder="What the team calls them (defaults to the legal name)" />
          </label>
          <label className="field">
            Email
            <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </label>
          <label className="field">
            Role
            <select value={form.roleKey} onChange={(e) => setForm({ ...form, roleKey: e.target.value })}>
              {roles.map((r) => (
                <option key={r.key} value={r.key}>{r.key} — {r.name}</option>
              ))}
            </select>
          </label>
          <p className="muted small">
            Permissions: {roles.find((r) => r.key === form.roleKey)?.permissions.join(', ') || '—'}
          </p>
          <button
            className="btn"
            type="button"
            disabled={!form.email || !form.legalName}
            onClick={() => act(async () => {
              const whose = form.displayName || form.legalName;
              const res = await api<{ tempPassword: string }>('/staff', { method: 'POST', body: { email: form.email, legalName: form.legalName, displayName: form.displayName || undefined, roleKey: form.roleKey } });
              setCopied(false);
              setReveal({ password: res.tempPassword, whose, how: 'created' });
              setMessage('');
              setForm({ email: '', legalName: '', displayName: '', roleKey: 'intern' });
              await load();
            })}
          >
            Create account
          </button>
        </section>
      </div>
    </>
  );
}
