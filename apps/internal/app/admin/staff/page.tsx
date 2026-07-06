'use client';

// Staff + permissions admin (M4 endpoints). Role changes land in the audit
// log as permission.change; deactivation revokes live sessions immediately.

import { useEffect, useState } from 'react';
import { api } from '../../../lib/api';

interface Staff { id: string; full_name: string; email: string; role: string; is_active: boolean; totp_enabled: boolean; last_login_at: string | null }
interface Role { key: string; name: string; permissions: string[] }

export default function StaffAdminPage() {
  const [staff, setStaff] = useState<Staff[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [form, setForm] = useState({ email: '', fullName: '', roleKey: 'intern' });
  const [tempPassword, setTempPassword] = useState('');
  const [message, setMessage] = useState('');

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

  return (
    <>
      <h1>Staff &amp; permissions</h1>
      {message ? <p className="alert info">{message}</p> : null}
      {tempPassword ? (
        <p className="alert info">
          Temporary password (shown once — hand over out-of-band, never email it): <strong>{tempPassword}</strong>.
          MFA enrollment is forced on their first sign-in.
        </p>
      ) : null}

      <div className="cards">
        <section className="card">
          <h2>Team</h2>
          <table>
            <thead><tr><th>Name</th><th>Role</th><th>MFA</th><th>Status</th><th /></tr></thead>
            <tbody>
              {staff.map((s) => (
                <tr key={s.id}>
                  <td>{s.full_name}<br /><span className="muted small">{s.email}</span></td>
                  <td>
                    <select
                      value={s.role}
                      onChange={async (e) => {
                        await api(`/staff/${s.id}`, { method: 'PATCH', body: { roleKey: e.target.value } });
                        setMessage(`${s.full_name} → ${e.target.value} (audited as permission.change).`);
                        await load();
                      }}
                    >
                      {roles.map((r) => (
                        <option key={r.key} value={r.key}>{r.key}</option>
                      ))}
                    </select>
                  </td>
                  <td>{s.totp_enabled ? <span className="badge ok">on</span> : <span className="badge warn">pending</span>}</td>
                  <td>{s.is_active ? <span className="badge ok">active</span> : <span className="badge danger">off</span>}</td>
                  <td style={{ width: 100 }}>
                    <button
                      className="btn ghost"
                      type="button"
                      onClick={async () => {
                        await api(`/staff/${s.id}`, { method: 'PATCH', body: { isActive: !s.is_active } });
                        await load();
                      }}
                    >
                      {s.is_active ? 'Deactivate' : 'Reactivate'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="card">
          <h2>Add staff</h2>
          <label className="field">
            Full name
            <input value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} />
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
            disabled={!form.email || !form.fullName}
            onClick={async () => {
              const res = await api<{ tempPassword: string }>('/staff', { method: 'POST', body: form });
              setTempPassword(res.tempPassword);
              setForm({ email: '', fullName: '', roleKey: 'intern' });
              await load();
            }}
          >
            Create account
          </button>
        </section>
      </div>
    </>
  );
}
