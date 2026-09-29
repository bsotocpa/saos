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
import { daysBetween, overdueSince } from './deadlines.ts';
import { getSetting } from './extension.ts';
import { F8879_SENT_METHOD_LABEL, type F8879SentMethod } from './f8879-sent.ts';

export interface QueueRow {
  /** R93: the day the return went overdue (its deadline passed, not filed), or null. */
  overdueSince: string | null;
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
  /** The staff member whose PTIN is on the filing; null reads "not recorded", never assumed. */
  preparerOfRecord: string | null;
  federalAcceptedOn: string | null;
  stateAcceptedOn: string | null;
  stateAcceptedCode: string | null;
  /**
   * AWAITING SIGNATURE (Brian, 2026-09-26, R53): the 8879 went to the client and the signed scan is
   * not back. `f8879Sent` is the record (method null when the Trello import declared it from a card
   * that said nothing about how); `awaitingSignature` is the state the queue prints, and
   * `awaitingSignatureText` the words: "awaiting signature (Adobe Sign, sent Sep 26, 2026)".
   */
  f8879Sent: { method: F8879SentMethod | null; sentOn: string; declaredByImport: boolean } | null;
  awaitingSignature: boolean;
  awaitingSignatureText: string | null;
}

/** "Sep 26, 2026" from a calendar day — the queue's own words, no zone applied to a DATE. */
function dayWords(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(y!, m! - 1, d!)));
}

/** The queue's sentence for a return whose 8879 is out and not back; null otherwise. */
export function awaitingSignatureText(sent: { method: F8879SentMethod | null; sentOn: string } | null, onFile: boolean): string | null {
  if (!sent || onFile) return null;
  const how = sent.method ? F8879_SENT_METHOD_LABEL[sent.method] : 'method not recorded';
  return `awaiting signature (${how}, sent ${dayWords(sent.sentOn)})`;
}

/**
 * Returns assigned to one preparer, deadline-first. Leadership can pass any
 * preparer id; a preparer only ever sees their own (enforced at the route).
 */
export async function preparerQueue(
  app: FastifyInstance,
  /** A preparer's own queue, or null for every open return (leadership only; the route decides). */
  preparerId: string | null,
  today: string
): Promise<{ queue: QueueRow[]; counts: { total: number; atRisk: number; rejected: number; awaitingDocs: number } }> {
  const atRiskMonthDay = await getSetting<string>(app, 'extension.at_risk_no_docs_by', '08-15');

  const { rows } = await app.db.query<{
    id: string; contact_id: string; first_name: string; last_name: string;
    tax_year: number; return_type: string; stage: string; extension_filed: boolean;
    docs_requested_at: Date | null; docs_received_at: Date | null;
    effective_deadline: string | null; perfection_deadline: string | null;
    open_doc_requests: number; blocked_by: number;
    preparer_of_record: string | null; federal_accepted_on: string | null; state_accepted_on: string | null; state_accepted_code: string | null;
    f8879_sent_method: F8879SentMethod | null; f8879_sent_on: string | null; f8879_sent_declared_by_import: boolean; f8879_document_id: string | null;
  }>(
    `SELECT te.id, e.contact_id, c.first_name, c.last_name, te.tax_year, te.return_type,
            te.stage::text, te.extension_filed, te.docs_requested_at, te.docs_received_at,
            COALESCE(te.extended_deadline, te.original_deadline)::text AS effective_deadline,
            te.perfection_deadline::text AS perfection_deadline,
            ptin.display_name AS preparer_of_record,
            te.federal_accepted_on::text AS federal_accepted_on, te.state_accepted_on::text AS state_accepted_on, te.state_accepted_code,
            te.f8879_sent_method, te.f8879_sent_on::text AS f8879_sent_on, te.f8879_sent_declared_by_import, te.f8879_document_id,
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
     LEFT JOIN staff ptin ON ptin.id = te.preparer_ptin_holder_id
     WHERE ($1::uuid IS NULL OR te.preparer_id = $1)
       AND te.stage NOT IN ('completed', 'withdrawn')
     ORDER BY COALESCE(te.extended_deadline, te.original_deadline) NULLS LAST, c.last_name`,
    [preparerId]
  );

  const queue: QueueRow[] = rows.map((r) => {
    const docState: QueueRow['docState'] =
      r.docs_received_at !== null ? 'docs_in' : r.docs_requested_at !== null ? 'requested' : 'awaiting_docs';
    const sent = r.f8879_sent_on ? { method: r.f8879_sent_method, sentOn: r.f8879_sent_on, declaredByImport: r.f8879_sent_declared_by_import } : null;
    return {
      id: r.id,
      contactId: r.contact_id,
      client: `${r.first_name} ${r.last_name}`,
      taxYear: r.tax_year,
      returnType: r.return_type,
      stage: r.stage,
      deadline: r.effective_deadline,
      overdueSince: overdueSince(r.effective_deadline, today, { stage: r.stage }),
      daysLeft: r.effective_deadline ? daysBetween(today, r.effective_deadline) : null,
      extended: r.extension_filed,
      // Same rule as the extension board, from the same setting.
      atRisk: r.extension_filed && r.docs_received_at === null && today.slice(5) >= atRiskMonthDay,
      docState,
      openDocRequests: r.open_doc_requests,
      blockedBy: r.blocked_by,
      rejected: r.stage === 'rejected',
      perfectionDeadline: r.perfection_deadline,
      preparerOfRecord: r.preparer_of_record,
      federalAcceptedOn: r.federal_accepted_on,
      stateAcceptedOn: r.state_accepted_on,
      stateAcceptedCode: r.state_accepted_code,
      f8879Sent: sent,
      awaitingSignature: sent !== null && r.f8879_document_id === null,
      awaitingSignatureText: awaitingSignatureText(sent, r.f8879_document_id !== null),
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
