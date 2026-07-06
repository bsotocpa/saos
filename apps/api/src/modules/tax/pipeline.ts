// Tax pipeline state machine (MP Tax Operations → Pipeline).
//
// GATES ENFORCED IN CODE (MP automations 7–8 — never convention):
//   1. Engagement letter signed  → required to advance PAST 'scheduled'
//   2. Estimated fee locked      → required to enter 'in_preparation'
//   3. Form 8879 signed          → required to enter 'filed'
// on_hold / withdrawn are always reachable; resuming from on_hold re-applies
// every gate. The parallel "Extended" state lives on extension_filed (M8),
// not in this stage enum.

import type { FastifyInstance } from 'fastify';
import { writeAudit } from '../../audit.ts';
import { AppError } from '../../types.ts';
import { invoiceForFiledEngagement } from '../billing/service.ts';

export const TAX_STAGES = [
  'intake_started', 'scheduled', 'documents_requested', 'pending_client_response',
  'in_preparation', 'internal_review', 'client_review', 'ready_to_file',
  'filed', 'completed', 'on_hold', 'withdrawn',
] as const;
export type TaxStage = (typeof TAX_STAGES)[number];

const ORDER: Partial<Record<TaxStage, number>> = {
  intake_started: 0, scheduled: 1, documents_requested: 2, pending_client_response: 3,
  in_preparation: 4, internal_review: 5, client_review: 6, ready_to_file: 7,
  filed: 8, completed: 9,
};

const RESUMABLE: TaxStage[] = [
  'scheduled', 'documents_requested', 'pending_client_response', 'in_preparation',
  'internal_review', 'client_review', 'ready_to_file',
];

/** Forward/backward moves allowed from each stage (before gates). */
const TRANSITIONS: Record<TaxStage, TaxStage[]> = {
  intake_started: ['scheduled'],
  scheduled: ['documents_requested'],
  documents_requested: ['pending_client_response', 'in_preparation'],
  pending_client_response: ['documents_requested', 'in_preparation'],
  in_preparation: ['documents_requested', 'pending_client_response', 'internal_review'],
  internal_review: ['in_preparation', 'client_review'],
  client_review: ['in_preparation', 'ready_to_file'],
  ready_to_file: ['client_review', 'filed'],
  filed: ['completed'],
  completed: [],
  on_hold: RESUMABLE,
  withdrawn: [],
};

/** Stages where the ball is in the client's court (delay attribution). */
const CLIENT_COURT: TaxStage[] = ['pending_client_response', 'client_review'];

interface GateRow {
  id: string;
  stage: TaxStage;
  engagement_letter_signed_at: Date | null;
  f8879_signed_at: Date | null;
  estimate_locked_at: Date | null;
  filed_date: string | null;
  contact_id: string;
}

export async function transitionStage(
  app: FastifyInstance,
  actor: { staffId: string | null; label: string },
  taxEngagementId: string,
  toStage: TaxStage,
  opts: { note?: string | undefined; ip?: string | null; userAgent?: string | null } = {}
): Promise<{ from: TaxStage; to: TaxStage }> {
  const { rows } = await app.db.query<GateRow>(
    `SELECT te.id, te.stage, te.engagement_letter_signed_at, te.f8879_signed_at,
            te.estimate_locked_at, te.filed_date, e.contact_id
     FROM tax_engagements te JOIN engagements e ON e.id = te.engagement_id
     WHERE te.id = $1`,
    [taxEngagementId]
  );
  const row = rows[0];
  if (!row) throw new AppError(404, 'not_found', 'Tax engagement not found.');
  const from = row.stage;

  const allowed =
    toStage === 'on_hold' || toStage === 'withdrawn'
      ? from !== 'completed' && from !== 'withdrawn' && from !== toStage
      : TRANSITIONS[from]?.includes(toStage) ?? false;
  if (!allowed) {
    throw new AppError(409, 'invalid_transition', `Cannot move from '${from}' to '${toStage}'.`);
  }

  // Gate 1 — engagement letter blocks everything past 'scheduled'.
  const targetOrder = ORDER[toStage];
  if (targetOrder !== undefined && targetOrder > ORDER.scheduled! && !row.engagement_letter_signed_at) {
    throw new AppError(
      409,
      'engagement_letter_required',
      'Blocked: the engagement letter is not signed. Work cannot advance past Scheduled until it is (MP compliance gate).'
    );
  }
  // Gate 2 — estimate locked unlocks preparation (automation 8).
  if (toStage === 'in_preparation' && !row.estimate_locked_at) {
    throw new AppError(
      409,
      'estimate_lock_required',
      'Blocked: the estimated fee range is not locked. Lock the estimate to unlock preparation (automation 8).'
    );
  }
  // Gate 3 — no return files without a signed 8879.
  if (toStage === 'filed' && !row.f8879_signed_at) {
    throw new AppError(
      409,
      'f8879_required',
      'Blocked: Form 8879 e-file authorization is not signed. No return is filed without it (MP compliance gate).'
    );
  }

  await app.db.query(
    `UPDATE tax_engagements
     SET stage = $2::tax_stage,
         filed_date = CASE WHEN $2 = 'filed' THEN COALESCE(filed_date, CURRENT_DATE) ELSE filed_date END
     WHERE id = $1`,
    [taxEngagementId, toStage]
  );
  await app.db.query(
    `INSERT INTO engagement_stage_history (tax_engagement_id, stage, changed_by_staff_id, waiting_on, note)
     VALUES ($1, $2::tax_stage, $3, $4::waiting_on, $5)`,
    [
      taxEngagementId,
      toStage,
      actor.staffId,
      CLIENT_COURT.includes(toStage) ? 'client' : 'staff',
      opts.note ?? null,
    ]
  );
  await writeAudit(app.db, {
    actorType: actor.staffId ? 'staff' : 'system',
    actorId: actor.staffId,
    actorLabel: actor.label,
    action: 'tax_engagement.stage_changed',
    objectType: 'tax_engagement',
    objectId: taxEngagementId,
    contactId: row.contact_id,
    ip: opts.ip,
    userAgent: opts.userAgent,
    details: { from, to: toStage },
  });

  // Automation 12: Filed → invoice generated (or an exception to Rene when
  // the final fee is missing — never a silent skip).
  if (toStage === 'filed') {
    await invoiceForFiledEngagement(app, actor, taxEngagementId);
  }

  return { from, to: toStage };
}

/**
 * Automation 4 (pipeline half): a document request flips the engagement to
 * pending_client_response and stamps docs_requested_at. The request/reminder
 * machinery itself lands in M10 — this is the stage side-effect.
 */
export async function markDocumentsRequested(
  app: FastifyInstance,
  actor: { staffId: string | null; label: string },
  taxEngagementId: string
): Promise<void> {
  await app.db.query(
    `UPDATE tax_engagements SET docs_requested_at = COALESCE(docs_requested_at, now()) WHERE id = $1`,
    [taxEngagementId]
  );
  const { rows } = await app.db.query<{ stage: TaxStage }>(
    `SELECT stage FROM tax_engagements WHERE id = $1`,
    [taxEngagementId]
  );
  const stage = rows[0]?.stage;
  if (stage === 'documents_requested' || stage === 'in_preparation') {
    await transitionStage(app, actor, taxEngagementId, 'pending_client_response', {
      note: 'auto: document request sent',
    });
  } else if (stage === 'scheduled') {
    // scheduled → documents_requested → pending_client_response (gates apply).
    await transitionStage(app, actor, taxEngagementId, 'documents_requested', { note: 'auto: document request sent' });
    await transitionStage(app, actor, taxEngagementId, 'pending_client_response', {
      note: 'auto: document request sent',
    });
  }
}
