/*
 * DECISION 1 (2026-09-09, Brian's evening ruling): a withdrawal never leaves a payable invoice
 * behind. SA-2026-0004 sat SENT on an engagement about to be withdrawn; the client still held a
 * live pay link for work that no longer existed.
 *
 * Withdrawing (or superseding by change order) now retires the engagement's payable invoices in
 * the same transaction: sent/overdue are VOIDED through the one void door (reason "engagement
 * withdrawn — <reason>", cancellation notice through its gate), drafts are DELETED (nothing was
 * issued, nothing to cancel). Migration 0085 holds the rule at the database from both sides.
 */
import type { FastifyInstance } from 'fastify';
import { writeAudit } from '../../audit.ts';

export interface RetiredInvoices {
  voided: string[];
  deleted: string[];
}

export async function retirePayableInvoices(
  app: FastifyInstance,
  engagementId: string,
  reason: string,
  actor: { id?: string | null; label: string }
): Promise<RetiredInvoices> {
  const { rows } = await app.db.query<{ id: string; invoice_number: string; status: string; contact_id: string }>(
    `SELECT id, invoice_number, status::text AS status, contact_id
       FROM invoices
      WHERE engagement_id = $1 AND status IN ('draft', 'sent', 'overdue')
      ORDER BY invoice_number`,
    [engagementId]
  );
  const voided: string[] = [];
  const deleted: string[] = [];
  const { voidInvoice } = await import('../billing/void.ts');
  for (const inv of rows) {
    if (inv.status === 'draft') {
      // References that would block the delete are detached first; the line items cascade.
      await app.db.query(`UPDATE quotes SET deposit_invoice_id = NULL WHERE deposit_invoice_id = $1`, [inv.id]);
      await app.db.query(`UPDATE time_entries SET invoice_id = NULL WHERE invoice_id = $1`, [inv.id]);
      await app.db.query(`UPDATE irs_notices SET invoice_id = NULL WHERE invoice_id = $1`, [inv.id]);
      await app.db.query(`DELETE FROM invoices WHERE id = $1 AND status = 'draft'`, [inv.id]);
      await writeAudit(app.db, {
        actorType: actor.id ? 'staff' : 'system', actorId: actor.id ?? null, actorLabel: actor.label,
        action: 'invoice.draft_deleted', objectType: 'invoice', objectId: inv.id, contactId: inv.contact_id,
        details: { invoice_number: inv.invoice_number, engagement_id: engagementId, reason },
      });
      deleted.push(inv.invoice_number);
      continue;
    }
    /*
     * THE CASCADE NAMES ITSELF AND THE PERSON BEHIND IT (2026-09-10). This ran under a system
     * actor with no staff id, so the invoice row said "(actor unknown)" about money. A cascade
     * is not anonymous — it was started by someone, and both halves belong on the record.
     */
    const label = actor.id ? actor.label : `system — engagement withdrawal by ${actor.label}`;
    await voidInvoice(app, inv.id, { reason: `Engagement withdrawn: ${reason}` }, { id: actor.id ?? null, fullName: label });
    voided.push(inv.invoice_number);
  }
  return { voided, deleted };
}
