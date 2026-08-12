'use client';

// Executive dashboard (MP: Brian's default view) — open returns by stage +
// value, revenue MTD/YTD, A/R aging, health distribution, staff capacity,
// deadline countdown. Exception-based: the point is what needs attention.

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, formatMoney, isAuthed } from '../lib/api';

interface Executive {
  openReturnsByStage: Array<{ stage: string; count: number; value_cents: string }>;
  revenue: { mtdCents: number; ytdCents: number };
  mrr: { cents: number; note: string };
  arAging: Array<{ bucket: string; count: number; owed_cents: string }>;
  healthDistribution: Array<{ band: string; count: number }>;
  staffCapacity: Array<{ full_name: string; role: string; open_tasks: number; open_returns: number }>;
  deadlines: {
    atRiskCount: number;
    extendedCount: number;
    next: Array<{ client: string; deadline: string; daysLeft: number }>;
    ag990Next: Array<{ business: string; deadline: string; daysLeft: number }>;
  };
  flows: {
    extensionBatchesAwaitingApproval: number;
    efileRejectsOpen: number;
    perfectionWindowClosing: number;
    openCloseCycles: number;
    vouchersDue: number;
    vouchersOverdue: number;
    onboardingStalled: number;
    workPaused: number;
  };
  pipeline: {
    openQuotes: number;
    openValueCents: number;
    acceptedValueCents: number;
    winRatePercent: number | null;
    byStage: Array<{ stage: string; count: number }>;
  };
  dubsadoRetirement: {
    migratedLoggedIn: number;
    migratedLoginTarget: number;
    closesCompleted: number;
    conditionA: boolean;
    conditionB: boolean;
    ready: boolean;
  };
}

const STAGE_LABELS: Record<string, string> = {
  intake_started: 'Intake', scheduled: 'Scheduled', documents_requested: 'Docs requested',
  pending_client_response: 'Waiting on client', in_preparation: 'In prep', internal_review: 'Internal review',
  client_review: 'Client review', ready_to_file: 'Ready to file', filed: 'Filed', on_hold: 'On hold',
};

interface Rollup {
  mine: Array<{ id: string; title: string; priority: number; due_date: string | null; source_type: string | null }>;
  approvals: Array<{ id: string; title: string }>;
  stalled: number;
  day60: number;
  vouchers_due: number;
}

interface SystemHealth {
  dependencies: Array<{
    name: string;
    reachable: boolean;
    since: string;
    detail: string | null;
    seconds_in_state: number | string;
  }>;
  documentScans: Array<{ status: string; n: number; oldest: string | null }>;
}

/** Infrastructure names as staff would say them, not as containers are named. */
const LABELS: Record<string, string> = {
  clamav: 'Virus scanning',
  postgres: 'Database',
};

/** "13h 20m" beats "48012 seconds" when the point is how long something has been broken. */
function formatDuration(seconds: number | string): string {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s < 60) return 'under a minute';
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const mins = Math.floor((s % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

export default function ExecutivePage() {
  const router = useRouter();
  const [data, setData] = useState<Executive | null>(null);
  const [rollup, setRollup] = useState<Rollup | null>(null);
  const [health, setHealth] = useState<SystemHealth | null>(null);

  useEffect(() => {
    if (!isAuthed()) {
      router.replace('/login');
      return;
    }
    void api<Executive>('/dashboards/executive').then(setData);
    void api<Rollup>('/tasks/rollup').then(setRollup);
    void api<SystemHealth>('/admin/system-health').then(setHealth);
  }, [router]);

  const awaitingScan = (health?.documentScans ?? [])
    .filter((s) => s.status === 'pending_scan' || s.status === 'skipped')
    .reduce((n, s) => n + s.n, 0);
  const infectedCount = (health?.documentScans ?? []).find((s) => s.status === 'infected')?.n ?? 0;

  if (!data) return <p className="muted">Loading…</p>;

  const bands = Object.fromEntries(data.healthDistribution.map((h) => [h.band, h.count]));

  return (
    <>
      <h1>Executive</h1>

      {/* FINDING #14(3): a wedged virus scanner was invisible here for thirteen hours
          and got discovered by reading OOM logs. It states the DURATION, because
          "unreachable" without "for how long" reads like a blip, and it names the
          client-facing consequence — uploads waiting to be filed — because that is
          what makes it urgent rather than merely red. Silent when all is well. */}
      {health && (health.dependencies.some((d) => !d.reachable) || awaitingScan > 0) ? (
        <section className="card" data-testid="system-health" style={{ borderColor: 'var(--danger, #b3261e)' }}>
          <h2>System health</h2>
          <ul className="list">
            {health.dependencies
              .filter((d) => !d.reachable)
              .map((d) => (
                <li key={d.name}>
                  <strong>{LABELS[d.name] ?? d.name} unreachable</strong> for {formatDuration(d.seconds_in_state)}
                  {d.detail ? <span className="muted small"> — {d.detail}</span> : null}
                </li>
              ))}
            {awaitingScan > 0 ? (
              <li>
                <strong>{awaitingScan} client upload{awaitingScan === 1 ? '' : 's'} awaiting a virus scan.</strong>{' '}
                <span className="muted small">
                  Stored and visible to the client, but not yet filed against their document
                  requests — so they are still being chased for them. Clears automatically
                  once the scanner is reachable.
                </span>
              </li>
            ) : null}
            {infectedCount > 0 ? (
              <li>
                <strong>{infectedCount} quarantined file{infectedCount === 1 ? '' : 's'}</strong>{' '}
                <span className="muted small">failed the virus scan — see your tasks.</span>
              </li>
            ) : null}
          </ul>
        </section>
      ) : null}

      {rollup ? (
        <section className="card" data-testid="owner-rollup" style={rollup.mine.length + rollup.approvals.length > 0 ? { borderColor: 'var(--electric)' } : undefined}>
          <h2>
            Needs you today{' '}
            <span className="muted small">
              {rollup.stalled > 0 ? `· ${rollup.stalled} stalled ` : ''}
              {rollup.day60 > 0 ? `· ${rollup.day60} day-60 deposits ` : ''}
              {rollup.vouchers_due > 0 ? `· ${rollup.vouchers_due} vouchers due` : ''}
            </span>
          </h2>
          {rollup.mine.length + rollup.approvals.length === 0 ? (
            <p className="muted">Clear — nothing waiting on you.</p>
          ) : (
            <ul className="list">
              {rollup.approvals.map((a) => (
                <li key={a.id}><span className="badge warn">approval</span> <span className="grow small">{a.title}</span></li>
              ))}
              {rollup.mine.slice(0, 8).map((m) => (
                <li key={m.id}>
                  <span className="grow small">
                    {m.title}
                    {m.due_date ? <span className="muted"> · due {m.due_date}</span> : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
      <div className="cards">
        <section className="card">
          <h2>Revenue</h2>
          <div className="stat-row">
            <div>
              <div className="stat" data-testid="revenue-mtd">{formatMoney(data.revenue.mtdCents)}</div>
              <div className="muted small">MTD collected</div>
            </div>
            <div>
              <div className="stat">{formatMoney(data.revenue.ytdCents)}</div>
              <div className="muted small">YTD collected</div>
            </div>
          </div>
          <p className="muted small">{data.mrr.note}</p>
        </section>

        <section className="card">
          <h2>Client health</h2>
          <div className="stat-row">
            <div><div className="stat" style={{ color: 'var(--ok)' }}>{bands.green ?? 0}</div><div className="muted small">Green</div></div>
            <div><div className="stat" style={{ color: 'var(--warn)' }}>{bands.yellow ?? 0}</div><div className="muted small">Yellow</div></div>
            <div><div className="stat" style={{ color: 'var(--danger)' }}>{bands.red ?? 0}</div><div className="muted small">Red</div></div>
            <div><div className="stat" style={{ color: 'var(--muted)' }}>{(bands.gray ?? 0) + (bands.unscored ?? 0)}</div><div className="muted small">Neutral</div></div>
          </div>
        </section>

        <section className="card">
          <h2>Deadlines</h2>
          <div className="stat-row">
            <div><div className="stat">{data.deadlines.extendedCount}</div><div className="muted small">Extended</div></div>
            <div><div className="stat" style={{ color: data.deadlines.atRiskCount > 0 ? 'var(--danger)' : 'var(--ok)' }}>{data.deadlines.atRiskCount}</div><div className="muted small">At risk</div></div>
          </div>
          {data.deadlines.next.slice(0, 3).map((d, i) => (
            <p key={i} className="small muted">{d.client} · {d.deadline} ({d.daysLeft}d)</p>
          ))}
          {data.deadlines.ag990Next.length > 0 ? (
            <>
              <h2 style={{ marginTop: 8 }}>AG990-IL (own clock)</h2>
              {data.deadlines.ag990Next.map((d, i) => (
                <p key={i} className="small muted">{d.business} · {d.deadline} ({d.daysLeft}d)</p>
              ))}
            </>
          ) : null}
        </section>

        <section className="card">
          <h2>Operational flows</h2>
          {(() => {
            // Defensive: a dashboard must not blank out because one payload
            // field is missing (e.g. mid-deploy, API older than the UI).
            const f = data.flows ?? ({} as Executive['flows']);
            const rows: Array<[string, number, boolean]> = [
              ['Extension batches to approve', f.extensionBatchesAwaitingApproval ?? 0, (f.extensionBatchesAwaitingApproval ?? 0) > 0],
              ['E-file rejects open', f.efileRejectsOpen ?? 0, (f.efileRejectsOpen ?? 0) > 0],
              ['Perfection window closing', f.perfectionWindowClosing ?? 0, (f.perfectionWindowClosing ?? 0) > 0],
              ['Books closes open', f.openCloseCycles ?? 0, false],
              ['Vouchers due', f.vouchersDue ?? 0, false],
              ['Vouchers past funder date', f.vouchersOverdue ?? 0, (f.vouchersOverdue ?? 0) > 0],
              ['Onboarding stalled (Day 60)', f.onboardingStalled ?? 0, (f.onboardingStalled ?? 0) > 0],
              ['Work paused — non-payment', f.workPaused ?? 0, (f.workPaused ?? 0) > 0],
            ];
            const live = rows.filter(([, n]) => n > 0);
            if (live.length === 0) return <p className="muted">Nothing outstanding across the seven flows.</p>;
            return live.map(([label, n, urgent]) => (
              <p key={label} className="small" style={{ margin: '3px 0' }}>
                <span className={`badge ${urgent ? 'danger' : ''}`}>{n}</span> {label}
              </p>
            ));
          })()}
        </section>

        <section className="card">
          <h2>Pipeline</h2>
          {(() => {
            const p = data.pipeline;
            if (!p) return <p className="muted">—</p>;
            if (p.openQuotes === 0 && p.acceptedValueCents === 0) {
              return <p className="muted">No quotes out yet.</p>;
            }
            return (
              <>
                <p className="small" style={{ margin: '3px 0' }}>
                  <span className="badge">{p.openQuotes}</span> open quotes · {formatMoney(p.openValueCents)} in play
                </p>
                <p className="small" style={{ margin: '3px 0' }}>
                  <span className="badge ok">{formatMoney(p.acceptedValueCents)}</span> accepted to date
                </p>
                <p className="muted small">
                  {p.winRatePercent === null
                    ? 'No quote has been decided yet — win rate needs a decision to measure.'
                    : `${p.winRatePercent}% win rate on decided quotes.`}
                </p>
              </>
            );
          })()}
        </section>

        <section className="card">
          <h2>Dubsado retirement</h2>
          {(() => {
            const d = data.dubsadoRetirement;
            if (!d) return <p className="muted">—</p>;
            if (d.ready) {
              return (
                <>
                  <p className="small">
                    <span className="badge ok">READY</span> Both conditions you set are met.
                  </p>
                  <p className="muted small">
                    {d.migratedLoggedIn} migrated clients have signed in and {d.closesCompleted} month-end
                    close{d.closesCompleted === 1 ? '' : 's'} ran in SAOS. The retirement task is in your queue.
                  </p>
                </>
              );
            }
            return (
              <>
                <p className="small" style={{ margin: '3px 0' }}>
                  <span className={`badge ${d.conditionA ? 'ok' : ''}`}>
                    {d.migratedLoggedIn}/{d.migratedLoginTarget}
                  </span>{' '}
                  migrated clients signed in
                </p>
                <p className="small" style={{ margin: '3px 0' }}>
                  <span className={`badge ${d.conditionB ? 'ok' : ''}`}>{d.closesCompleted}/1</span>{' '}
                  month-end close completed in SAOS
                </p>
                <p className="muted small">
                  Your trigger: both, then stop dual-running. You&apos;ll get one alert — no daily nag.
                </p>
              </>
            );
          })()}
        </section>

        <section className="card span">
          <h2>Open returns by stage</h2>
          <table>
            <thead><tr><th>Stage</th><th>Count</th><th>Value</th></tr></thead>
            <tbody>
              {data.openReturnsByStage.map((s) => (
                <tr key={s.stage}>
                  <td>{STAGE_LABELS[s.stage] ?? s.stage}</td>
                  <td>{s.count}</td>
                  <td>{formatMoney(Number(s.value_cents))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="card">
          <h2>A/R aging</h2>
          <table>
            <thead><tr><th>Age</th><th>Invoices</th><th>Owed</th></tr></thead>
            <tbody>
              {data.arAging.map((b) => (
                <tr key={b.bucket}>
                  <td><span className={`badge ${b.bucket === '90+' || b.bucket === '61-90' ? 'danger' : b.bucket === '31-60' ? 'warn' : ''}`}>{b.bucket}d</span></td>
                  <td>{b.count}</td>
                  <td>{formatMoney(Number(b.owed_cents))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="card">
          <h2>Staff capacity</h2>
          <table>
            <thead><tr><th>Staff</th><th>Tasks</th><th>Returns</th></tr></thead>
            <tbody>
              {data.staffCapacity.map((s) => (
                <tr key={s.full_name}>
                  <td>{s.full_name} <span className="muted small">({s.role})</span></td>
                  <td>{s.open_tasks}</td>
                  <td>{s.open_returns}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </>
  );
}
