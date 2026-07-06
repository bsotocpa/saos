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
  deadlines: { atRiskCount: number; extendedCount: number; next: Array<{ client: string; deadline: string; daysLeft: number }> };
}

const STAGE_LABELS: Record<string, string> = {
  intake_started: 'Intake', scheduled: 'Scheduled', documents_requested: 'Docs requested',
  pending_client_response: 'Waiting on client', in_preparation: 'In prep', internal_review: 'Internal review',
  client_review: 'Client review', ready_to_file: 'Ready to file', filed: 'Filed', on_hold: 'On hold',
};

export default function ExecutivePage() {
  const router = useRouter();
  const [data, setData] = useState<Executive | null>(null);

  useEffect(() => {
    if (!isAuthed()) {
      router.replace('/login');
      return;
    }
    void api<Executive>('/dashboards/executive').then(setData);
  }, [router]);

  if (!data) return <p className="muted">Loading…</p>;

  const bands = Object.fromEntries(data.healthDistribution.map((h) => [h.band, h.count]));

  return (
    <>
      <h1>Executive</h1>
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
