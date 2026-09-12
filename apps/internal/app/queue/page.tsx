'use client';

// The preparer queue (M28, wireframe preparer step 1): "assigned to me, today's
// returns, prioritized".
//
// Deadline-sorted, with REJECTS PINNED TO THE TOP — the perfection-period clock is
// the shortest fuse a preparer ever holds and is easy to lose behind a plain
// deadline sort. Red is reserved for the two things that are actually urgent: a
// reject inside its window, and an extended return with no documents past the
// at-risk date. Everything else stays quiet.

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, isAuthed } from '../../lib/api';

interface QueueRow {
  id: string;
  contactId: string;
  client: string;
  taxYear: number;
  returnType: string;
  stage: string;
  deadline: string | null;
  daysLeft: number | null;
  extended: boolean;
  atRisk: boolean;
  docState: 'docs_in' | 'awaiting_docs' | 'requested';
  openDocRequests: number;
  blockedBy: number;
  rejected: boolean;
  perfectionDeadline: string | null;
  preparerOfRecord: string | null;
  federalAcceptedOn: string | null;
  stateAcceptedOn: string | null;
  stateAcceptedCode: string | null;
}

const DOC_LABEL: Record<QueueRow['docState'], string> = {
  docs_in: 'Docs in',
  requested: 'Docs requested',
  awaiting_docs: 'No docs yet',
};

export default function QueuePage() {
  const router = useRouter();
  const [rows, setRows] = useState<QueueRow[]>([]);
  const [counts, setCounts] = useState<{ total: number; atRisk: number; rejected: number; awaitingDocs: number } | null>(null);
  const [scoped, setScoped] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const r = await api<{
        queue: QueueRow[];
        counts: { total: number; atRisk: number; rejected: number; awaitingDocs: number };
        scoped: boolean;
      }>('/my-queue');
      setRows(r.queue);
      setCounts(r.counts);
      setScoped(r.scoped);
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

  return (
    <>
      <h1>My queue</h1>
      {error ? <div className="alert error">{error}</div> : null}

      {counts ? (
        <section className="card" style={{ marginBottom: 12 }}>
          <div className="stat-row">
            <div><div className="stat">{counts.total}</div><div className="muted small">Returns assigned</div></div>
            <div>
              <div className="stat" style={{ color: counts.rejected > 0 ? 'var(--danger)' : undefined }}>
                {counts.rejected}
              </div>
              <div className="muted small">Rejected</div>
            </div>
            <div>
              <div className="stat" style={{ color: counts.atRisk > 0 ? 'var(--danger)' : undefined }}>
                {counts.atRisk}
              </div>
              <div className="muted small">At risk</div>
            </div>
            <div><div className="stat">{counts.awaitingDocs}</div><div className="muted small">Waiting on docs</div></div>
          </div>
          <p className="muted small">
            Sorted by deadline, with rejects pinned to the top — the perfection-period clock is shorter
            than any filing deadline.
            {scoped ? ' You see only the returns assigned to you.' : ''}
          </p>
        </section>
      ) : null}

      {rows.length === 0 ? (
        <section className="card">
          <p className="muted">
            {counts ? 'Nothing assigned to you right now.' : 'Loading…'}
          </p>
        </section>
      ) : (
        rows.map((r) => {
          const urgent = r.rejected || r.atRisk;
          const overdue = r.daysLeft !== null && r.daysLeft < 0;
          return (
            <section
              className="card"
              key={r.id}
              style={{ marginBottom: 10, ...(urgent ? { borderColor: 'var(--danger)' } : {}) }}
            >
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-start' }}>
                <span style={{ flex: 1, minWidth: 200 }}>
                  <strong>{r.client}</strong>{' '}
                  <span className="badge">{r.taxYear} {r.returnType.toUpperCase()}</span>{' '}
                  {r.rejected ? <span className="badge danger">REJECTED</span> : null}
                  {r.atRisk ? <span className="badge danger">at risk</span> : null}
                  {r.extended && !r.atRisk ? <span className="badge warn">extended</span> : null}
                  {r.blockedBy > 0 ? <span className="badge warn">blocked ×{r.blockedBy}</span> : null}
                  <br />
                  <span className="muted small">
                    {r.stage.replaceAll('_', ' ')} · {DOC_LABEL[r.docState]}
                    {r.stage === 'filed' || r.stage === 'rejected' ? ` · preparer of record: ${r.preparerOfRecord ?? 'not recorded'}` : ''}
                    {r.openDocRequests > 0 ? ` (${r.openDocRequests} open request${r.openDocRequests === 1 ? '' : 's'})` : ''}
                  </span>
                  <br />
                  <span className="small">
                    {r.rejected && r.perfectionDeadline ? (
                      <strong style={{ color: 'var(--danger)' }}>
                        Perfection period ends {r.perfectionDeadline}
                      </strong>
                    ) : r.deadline ? (
                      <span style={overdue ? { color: 'var(--danger)', fontWeight: 600 } : undefined}>
                        Due {r.deadline}
                        {r.daysLeft !== null
                          ? overdue
                            ? ` · ${Math.abs(r.daysLeft)}d PAST`
                            : ` · ${r.daysLeft}d left`
                          : ''}
                      </span>
                    ) : (
                      <span className="muted">No deadline derived yet</span>
                    )}
                  </span>
                </span>
                <span className="chipbar" style={{ marginBottom: 0 }}>
                  <a className="btn ghost" href={`/clients/${r.contactId}`}>Client packet</a>
                </span>
              </div>
            </section>
          );
        })
      )}
    </>
  );
}
