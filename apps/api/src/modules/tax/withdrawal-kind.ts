/*
 * CORRECTING A WITHDRAWAL'S KIND (Brian, 2026-10-02, R118). R117 records the kind with the withdrawal,
 * chosen by the person withdrawing; this is the door for the wrong button. The CEO alone (the
 * permission engagements.tax.withdrawal_kind.correct is explicit-only), with a standalone reason, and
 * audited with the kind before and after:
 *   to 'firm_record'  the firm's own record: the return leaves the client's portal entirely;
 *   to 'client'       the client's work ended: the portal shows it again, one line, the fixed sentence.
 * A kind set by a change order is the agreement's, not a person's, and is not corrected here; a return
 * that is not withdrawn has no kind to correct; asking for the kind it already has changes nothing and
 * is refused, so the audit never carries a correction that was not one.
 */
import type { FastifyInstance } from 'fastify';
import { writeAudit } from '../../audit.ts';
import { AppError } from '../../types.ts';
import type { WithdrawalKind } from './withdrawn.ts';

export const CORRECT_WITHDRAWAL_KIND_PERMISSION = 'engagements.tax.withdrawal_kind.correct';

const WORDS: Record<'client' | 'firm_record', string> = {
  client: "the client's work ended",
  firm_record: 'our own record',
};

export async function correctWithdrawalKind(
  app: FastifyInstance,
  actor: { staffId: string; label: string; ip?: string | null; userAgent?: string | null },
  taxEngagementId: string,
  kind: 'client' | 'firm_record',
  reason: string
): Promise<{ before: WithdrawalKind; after: 'client' | 'firm_record' }> {
  const { rows } = await app.db.query<{ stage: string; withdrawal_kind: WithdrawalKind | null; contact_id: string }>(
    `SELECT te.stage::text AS stage, te.withdrawal_kind, e.contact_id
       FROM tax_engagements te JOIN engagements e ON e.id = te.engagement_id WHERE te.id = $1`,
    [taxEngagementId]
  );
  const te = rows[0];
  if (!te) throw new AppError(404, 'not_found', 'Tax engagement not found.');
  if (te.stage !== 'withdrawn' || !te.withdrawal_kind) {
    throw new AppError(409, 'not_withdrawn', 'This return is not withdrawn, so it has no withdrawal kind to correct.');
  }
  if (te.withdrawal_kind === 'change_order') {
    throw new AppError(409, 'set_by_change_order', 'A change order withdrew this return; its kind is the agreement\'s and is not corrected here.');
  }
  if (te.withdrawal_kind === kind) {
    throw new AppError(409, 'unchanged', `This withdrawal is already "${WORDS[kind]}". Nothing was changed.`);
  }
  const before = te.withdrawal_kind;
  await app.db.query(`UPDATE tax_engagements SET withdrawal_kind = $2 WHERE id = $1 AND stage = 'withdrawn'`, [taxEngagementId, kind]);
  await writeAudit(app.db, {
    actorType: 'staff', actorId: actor.staffId, actorLabel: actor.label,
    action: 'tax_engagement.withdrawal_kind_corrected', objectType: 'tax_engagement', objectId: taxEngagementId,
    contactId: te.contact_id, ip: actor.ip ?? null, userAgent: actor.userAgent ?? null,
    details: { before, after: kind, reason, portal: kind === 'firm_record' ? 'hidden' : 'shown' },
  });
  return { before, after: kind };
}
