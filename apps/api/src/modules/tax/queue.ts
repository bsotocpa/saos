// The preparer queue (M28) — "assigned to me, today's returns, prioritized".
//
// The wireframe's preparer persona lives in this screen, and until now the only
// return-shaped list was the leadership deadline board. My Tasks is task-shaped:
// it answers "what should I do next", not "which returns am I carrying and which
// one is closest to a deadline".
//
// The deadline is DERIVED, never stored as a literal: original vs extended comes
// off the engagement, and days-left is computed against the firm's today. The
// at-risk rule is the same setting the extension board uses, so the two screens
// can never disagree about what "late" means.

import type { FastifyInstance } from 'fastify';
import { daysBetween } from './deadlines.ts';
import { getSetting } from './extension.ts';

export interface QueueRow {
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
  /** What the preparer is actually waiting on, in the wireframe's language. */
  docState: 'docs_in' | 'awaiting_docs' | 'requested';
  openDocRequests: number;
  blockedBy: number;
  rejected: boolean;
  perfectionDeadline: string | null;
}

/**
 * Returns assigned to one preparer, deadline-first. Leadership can pass any
 * preparer id; a preparer only ever sees their own (enforced at the route).
 */
export async function preparerQueue(
  app: FastifyInstance,
  preparerId: string,
  today: string
): Promise<{ queue: QueueRow[]; counts: { total: number; atRisk: number; rejected: number; awaitingDocs: number } }> {
  const atRiskMonthDay = await getSetting<string>(app, 'extension.at_risk_no_docs_by', '08-15');

  const { rows } = await app.db.query<{
    id: string; contact_id: string; first_name: string; last_name: string;
    tax_year: number; return_type: string; stage: string; extension_filed: boolean;
    docs_requested_at: Date | null; docs_received_at: Date | null;
    effective_deadline: string | null; perfection_deadline: string | null;
    open_doc_requests: number; blocked_by: number;
  }>(
    `SELECT te.id, e.contact_id, c.first_name, c.last_name, te.tax_year, te.return_type,
            te.stage::text, te.extension_filed, te.docs_requested_at, te.docs_received_at,
            COALESCE(te.extended_deadline, te.original_deadline)::text AS effective_deadline,
            te.perfection_deadline::text AS perfection_deadline,
            (SELECT count(*)::int FROM document_requests dr
             WHERE dr.tax_engagement_id = te.id AND dr.completed_at IS NULL) AS open_doc_requests,
            (SELECT count(*)::int FROM tasks t
             JOIN task_dependencies d ON d.blocked_task_id = t.id
             JOIN tasks bt ON bt.id = d.blocker_task_id
             WHERE t.source_type = 'resolution_year' AND t.source_id = te.id::text
               AND NOT (bt.status = ANY(ARRAY['completed','cancelled']::task_status[]))) AS blocked_by
     FROM tax_engagements te
     JOIN engagements e ON e.id = te.engagement_id
     JOIN contacts c ON c.id = e.contact_id
     WHERE te.preparer_id = $1
       AND te.stage NOT IN ('completed', 'withdrawn')
     ORDER BY COALESCE(te.extended_deadline, te.original_deadline) NULLS LAST, c.last_name`,
    [preparerId]
  );

  const queue: QueueRow[] = rows.map((r) => {
    const docState: QueueRow['docState'] =
      r.docs_received_at !== null ? 'docs_in' : r.docs_requested_at !== null ? 'requested' : 'awaiting_docs';
    return {
      id: r.id,
      contactId: r.contact_id,
      client: `${r.first_name} ${r.last_name}`,
      taxYear: r.tax_year,
      returnType: r.return_type,
      stage: r.stage,
      deadline: r.effective_deadline,
      daysLeft: r.effective_deadline ? daysBetween(today, r.effective_deadline) : null,
      extended: r.extension_filed,
      // Same rule as the extension board, from the same setting.
      atRisk: r.extension_filed && r.docs_received_at === null && today.slice(5) >= atRiskMonthDay,
      docState,
      openDocRequests: r.open_doc_requests,
      blockedBy: r.blocked_by,
      rejected: r.stage === 'rejected',
      perfectionDeadline: r.perfection_deadline,
    };
  });

  // Rejects jump to the top of the queue: the perfection-period clock is the
  // shortest fuse a preparer ever holds, and it is easy to miss behind a
  // deadline sort that treats a rejected return like any other.
  queue.sort((a, b) => {
    if (a.rejected !== b.rejected) return a.rejected ? -1 : 1;
    if (a.deadline === b.deadline) return a.client.localeCompare(b.client);
    if (a.deadline === null) return 1;
    if (b.deadline === null) return -1;
    return a.deadline < b.deadline ? -1 : 1;
  });

  return {
    queue,
    counts: {
      total: queue.length,
      atRisk: queue.filter((q) => q.atRisk).length,
      rejected: queue.filter((q) => q.rejected).length,
      awaitingDocs: queue.filter((q) => q.docState !== 'docs_in').length,
    },
  };
}
