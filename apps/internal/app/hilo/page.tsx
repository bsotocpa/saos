'use client';

// Hilo Ops dashboard (MP: Jackson's default view) — entrepreneurs by status,
// sessions, referral queues, recent summaries, LIVE funder metrics.

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, formatMoney, isAuthed } from '../../lib/api';

interface Hilo {
  entrepreneursByStatus: Array<{ hilo_status: string; count: number }>;
  sessionsThisMonth: number;
  referralQueues: Array<{ direction: string; pending: number }>;
  recentSummaries: Array<{ summary: string; tax_need: boolean; title: string | null; first_name: string | null; last_name: string | null }>;
  milestones30d: { note: string; items: unknown[] };
  funderMetrics: {
    entrepreneursImpacted: number;
    byNeighborhood: Array<{ zip: string; count: number }>;
    proBonoHours: number;
    proBonoValueCents: number;
    grantsDistributed: { note: string };
    workshopAttendance: { note: string };
  };
}

export default function HiloPage() {
  const router = useRouter();
  const [data, setData] = useState<Hilo | null>(null);

  useEffect(() => {
    if (!isAuthed()) {
      router.replace('/login');
      return;
    }
    void api<Hilo>('/dashboards/hilo').then(setData);
  }, [router]);

  if (!data) return <p className="muted">Loading…</p>;

  return (
    <>
      <h1>Hilo Ops</h1>
      <div className="cards">
        <section className="card">
          <h2>Entrepreneurs</h2>
          <div className="stat" data-testid="impacted">{data.funderMetrics.entrepreneursImpacted}</div>
          <div className="muted small">impacted (live funder metric)</div>
          <table style={{ marginTop: 8 }}>
            <tbody>
              {data.entrepreneursByStatus.map((s) => (
                <tr key={s.hilo_status}>
                  <td>{s.hilo_status}</td>
                  <td><span className="badge">{s.count}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="card">
          <h2>Pro bono (funder report)</h2>
          <div className="stat-row">
            <div><div className="stat">{data.funderMetrics.proBonoHours}</div><div className="muted small">hours</div></div>
            <div><div className="stat">{formatMoney(data.funderMetrics.proBonoValueCents)}</div><div className="muted small">value (hours × standard rate)</div></div>
          </div>
          <p className="muted small">Sessions this month: {data.sessionsThisMonth}</p>
        </section>

        <section className="card">
          <h2>Referral queues</h2>
          {data.referralQueues.length === 0 ? <p className="muted small">Nothing pending.</p> : null}
          {data.referralQueues.map((q) => (
            <p key={q.direction}>
              {q.direction === 'hilo_to_soto' ? 'Hilo → Soto' : 'Soto → Hilo'}{' '}
              <span className="badge warn">{q.pending} pending</span>
            </p>
          ))}
        </section>

        <section className="card">
          <h2>By neighborhood</h2>
          <table>
            <tbody>
              {data.funderMetrics.byNeighborhood.map((n) => (
                <tr key={n.zip}><td>{n.zip}</td><td>{n.count}</td></tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="card span">
          <h2>Session summaries (7 days)</h2>
          {data.recentSummaries.length === 0 ? <p className="muted small">No sessions this week.</p> : null}
          {data.recentSummaries.map((s, i) => (
            <p key={i} className="small">
              <strong>{s.title ?? `${s.first_name ?? ''} ${s.last_name ?? ''}`}</strong>
              {s.tax_need ? <span className="badge warn" style={{ marginLeft: 6 }}>tax need</span> : null}
              <br />
              <span className="muted">{s.summary}</span>
            </p>
          ))}
        </section>

        <section className="card span">
          <h2>Coming online later</h2>
          <p className="muted small">
            Milestones: {data.milestones30d.note} · Grants: {data.funderMetrics.grantsDistributed.note} · Workshops:{' '}
            {data.funderMetrics.workshopAttendance.note}
          </p>
        </section>
      </div>
    </>
  );
}
