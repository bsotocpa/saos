'use client';

// WISP security summary (M21): live posture — MFA enrollment, audit stats,
// backup + restore-drill recency — exportable as markdown for the written
// WISP whenever the IRS checklist or an insurer asks.

import { useEffect, useState } from 'react';
import { api } from '../../../lib/api';

interface Summary {
  generated_at: string;
  environment: string;
  access_control: {
    staff: Array<{ full_name: string; email: string; role: string; is_active: boolean; totp_enabled: boolean; last_login_at: string | null }>;
    active_count: number;
    mfa_enrolled_count: number;
    mfa_pending: string[];
    mfa_policy: string;
    session_policy: { idle_minutes: number; absolute_hours: number };
    lockout_policy: { max_attempts: number; lockout_minutes: number };
    client_auth: string;
  };
  audit: {
    total_events: number; events_30d: number; document_access_30d: number;
    permission_changes_30d: number; oldest_event_at: string | null; newest_event_at: string | null;
  };
  encryption: Record<string, string>;
  backups: {
    configured: boolean; last_backup_at: string | null; snapshot_id: string | null;
    repository_kind: string | null; retention: string | null; stale: boolean;
    restore_drill: { last_passed_at: string | null; interval_days: number; overdue: boolean };
  };
  approved_vendors: string[];
  storage: string;
}

export default function WispPage() {
  const [s, setS] = useState<Summary | null>(null);

  useEffect(() => {
    void api<Summary>('/admin/wisp/security-summary').then(setS);
  }, []);

  const download = async () => {
    const res = await fetch('/api/admin/wisp/security-summary?format=markdown');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `saos-security-summary-${new Date().toISOString().slice(0, 10)}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (!s) return <p className="muted">Loading…</p>;

  const drill = s.backups.restore_drill;
  return (
    <>
      <h1>
        WISP security summary <span className="badge">{s.environment}</span>
      </h1>
      <p className="muted small">
        Live posture as of {s.generated_at}.{' '}
        <button className="btn ghost" type="button" onClick={() => void download()}>
          Download for the WISP binder (.md)
        </button>
      </p>

      <div className="cards">
        <section className="card">
          <h2>Access control</h2>
          <p className="small">{s.access_control.mfa_policy}.</p>
          <p className="small">
            Active staff: <strong>{s.access_control.active_count}</strong> · MFA enrolled:{' '}
            <strong>{s.access_control.mfa_enrolled_count}</strong>
            {s.access_control.mfa_pending.length > 0 ? (
              <span className="badge warn"> pending: {s.access_control.mfa_pending.join(', ')}</span>
            ) : (
              <span className="badge ok"> all enrolled</span>
            )}
          </p>
          <p className="muted small">
            Sessions: {s.access_control.session_policy.idle_minutes}m idle / {s.access_control.session_policy.absolute_hours}h absolute ·
            Lockout: {s.access_control.lockout_policy.max_attempts} attempts → {s.access_control.lockout_policy.lockout_minutes}m
          </p>
          <table>
            <thead><tr><th>Staff</th><th>Role</th><th>MFA</th><th>Last login</th></tr></thead>
            <tbody>
              {s.access_control.staff.map((m) => (
                <tr key={m.email}>
                  <td>{m.full_name}{m.is_active ? '' : ' (inactive)'}</td>
                  <td className="muted small">{m.role}</td>
                  <td>{m.totp_enabled ? <span className="badge ok">on</span> : <span className="badge warn">pending</span>}</td>
                  <td className="muted small">{m.last_login_at ? m.last_login_at.slice(0, 10) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="card">
          <h2>Audit trail (append-only)</h2>
          <p className="small">
            <strong>{s.audit.total_events.toLocaleString()}</strong> events total ·{' '}
            {s.audit.events_30d.toLocaleString()} in 30 days
          </p>
          <p className="muted small">
            Document access (30d): {s.audit.document_access_30d} · Permission changes (30d): {s.audit.permission_changes_30d}
            <br />
            Coverage: {s.audit.oldest_event_at?.slice(0, 10) ?? '—'} → {s.audit.newest_event_at?.slice(0, 10) ?? '—'}
          </p>
        </section>

        <section className="card" style={s.backups.stale || drill.overdue ? { borderColor: 'var(--warn)' } : undefined}>
          <h2>Backups &amp; recovery</h2>
          {s.backups.configured ? (
            <p className="small">
              Last snapshot <strong>{s.backups.snapshot_id?.slice(0, 8)}</strong> at {s.backups.last_backup_at}{' '}
              ({s.backups.repository_kind}) {s.backups.stale ? <span className="badge danger">STALE &gt;26h</span> : <span className="badge ok">fresh</span>}
              <br />
              <span className="muted">Retention: {s.backups.retention}</span>
            </p>
          ) : (
            <p className="alert info">No backup recorded on this machine — scripts/backup.sh has not run here (see RUNBOOK_OPS.md).</p>
          )}
          <p className="small">
            Restore drill: {drill.last_passed_at ? `last passed ${drill.last_passed_at.slice(0, 10)}` : 'NEVER RUN'}{' '}
            {drill.overdue ? <span className="badge danger">overdue</span> : <span className="badge ok">on cadence</span>}
            <span className="muted"> (every {drill.interval_days} days; record passes in Settings → ops.last_restore_drill_at)</span>
          </p>
        </section>

        <section className="card">
          <h2>Encryption &amp; vendors</h2>
          <ul className="list small">
            {Object.entries(s.encryption).map(([k, v]) => (
              <li key={k}><strong>{k.replace(/_/g, ' ')}</strong>: {v}</li>
            ))}
          </ul>
          <p className="muted small">Approved external vendors (client data never goes anywhere else):</p>
          <ul className="list small">
            {s.approved_vendors.map((v) => (
              <li key={v}>{v}</li>
            ))}
          </ul>
          <p className="muted small">{s.storage}</p>
        </section>
      </div>
    </>
  );
}
