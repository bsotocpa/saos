/*
 * THE BILLING HOLD (Brian, 2026-09-26, R68).
 *
 * "Trello-sourced ongoing engagements carry a billing-hold flag checked by every invoice factory,
 * so no imported sales-tax, payroll or bookkeeping engagement can invoice until Brian lifts the
 * hold per engagement through an Ops control with a reason."
 *
 * ONE PREDICATE, READ WHERE MONEY IS MADE. Every invoice in SAOS is written by createInvoice
 * (billing/service.ts, the only INSERT INTO invoices), and createInvoice asks this module before it
 * writes. The paths that reach it — the filed-return automation, quote acceptance, the manual
 * invoice route, the notice bill, the consolidated group invoice — need no rule of their own. Two of
 * them read the hold themselves as well, for a better answer than a thrown 409:
 *
 *   · the filed-return factory is job-shaped (it runs inside a stage move nobody should have to
 *     retry), so it counts the refusal and raises a task instead of failing the filing;
 *   · the consolidated invoice names no engagement of its own, so it checks each return's parent.
 *
 * The hold is PLACED by the importer alone (engagements/import-facts.ts, on every ongoing engagement
 * it creates) and LIFTED by a person holding engagements.billing_hold.lift — explicit-only, seeded to
 * the CEO, because Brian said "until Brian lifts the hold". Every refusal is audited as
 * invoice.refused_billing_hold with the engagement it named, never a client's name.
 */
import type { FastifyInstance } from 'fastify';
import { writeAudit } from '../../audit.ts';
import { AppError } from '../../types.ts';

/** The sentence the importer writes as the hold's reason. One spelling, exported so the specs read it. */
export const IMPORT_BILLING_HOLD_REASON = 'Imported from Trello; billing starts when the CEO lifts the hold.';

export interface BillingHoldActor {
  type: 'staff' | 'system';
  id?: string | null;
  label?: string | null;
}

interface HoldRow {
  id: string;
  contact_id: string;
  service_line: string;
  title: string | null;
  billing_hold: boolean;
  billing_hold_reason: string | null;
}

async function loadHold(app: FastifyInstance, engagementId: string): Promise<HoldRow | null> {
  const { rows } = await app.db.query<HoldRow>(
    `SELECT id, contact_id, service_line::text AS service_line, title, billing_hold, billing_hold_reason
       FROM engagements WHERE id = $1`,
    [engagementId]
  );
  return rows[0] ?? null;
}

/** The words every refusal carries: the engagement, never the client. */
function refusalMessage(row: HoldRow): string {
  const name = row.title ? `"${row.title}"` : `the ${row.service_line} engagement`;
  return `Billing is on hold for ${name} (${row.service_line}): ${row.billing_hold_reason ?? 'no reason recorded'} Lift the hold on the client page before invoicing it.`;
}

/**
 * Is this engagement held? Audits the refusal when it is, so a job that counts suppressions and a
 * route that throws both leave the same row. Returns the message for the caller to use.
 */
export async function billingHoldRefusal(
  app: FastifyInstance,
  engagementId: string,
  actor: BillingHoldActor,
  context: { via: string }
): Promise<{ held: false } | { held: true; message: string; contactId: string }> {
  const row = await loadHold(app, engagementId);
  if (!row || !row.billing_hold) return { held: false };
  await writeAudit(app.db, {
    actorType: actor.type,
    actorId: actor.id ?? null,
    actorLabel: actor.label ?? null,
    action: 'invoice.refused_billing_hold',
    objectType: 'engagement',
    objectId: row.id,
    contactId: row.contact_id,
    details: { via: context.via, service_line: row.service_line, reason: row.billing_hold_reason },
  });
  return { held: true, message: refusalMessage(row), contactId: row.contact_id };
}

/** The throwing form, for the factories a person is waiting on: 409 billing_hold, audited. */
export async function assertNotBillingHeld(
  app: FastifyInstance,
  engagementId: string,
  actor: BillingHoldActor,
  context: { via: string }
): Promise<void> {
  const r = await billingHoldRefusal(app, engagementId, actor, context);
  if (r.held) throw new AppError(409, 'billing_hold', r.message);
}

/**
 * Place the hold. Called by the importer on an engagement it just created; the reason is the
 * importer's sentence. Idempotent: an engagement already held keeps its reason.
 */
export async function placeBillingHold(
  app: FastifyInstance,
  engagementId: string,
  reason: string,
  actor: BillingHoldActor
): Promise<void> {
  const updated = await app.db.query(
    `UPDATE engagements SET billing_hold = true, billing_hold_reason = $2 WHERE id = $1 AND NOT billing_hold`,
    [engagementId, reason]
  );
  if ((updated.rowCount ?? 0) === 0) return;
  const row = await loadHold(app, engagementId);
  await writeAudit(app.db, {
    actorType: actor.type,
    actorId: actor.id ?? null,
    actorLabel: actor.label ?? null,
    action: 'engagement.billing_hold_placed',
    objectType: 'engagement',
    objectId: engagementId,
    contactId: row?.contact_id ?? null,
    details: { reason },
  });
}

/**
 * Lift the hold: the moment, the person and the reason land together (the CHECK in 0123 refuses a
 * partial lift). Refuses an engagement that is not held, so a stale button says so rather than
 * writing a lift nobody asked for.
 */
export async function liftBillingHold(
  app: FastifyInstance,
  engagementId: string,
  input: { reason: string },
  actor: { id: string; label: string }
): Promise<{ engagementId: string; contactId: string; liftedAt: string }> {
  const row = await loadHold(app, engagementId);
  if (!row) throw new AppError(404, 'not_found', 'Engagement not found.');
  if (!row.billing_hold) {
    throw new AppError(409, 'not_on_billing_hold', 'This engagement is not on a billing hold. Nothing to lift.');
  }
  const { rows } = await app.db.query<{ lifted_at: Date }>(
    `UPDATE engagements
        SET billing_hold = false,
            billing_hold_lifted_at = now(),
            billing_hold_lifted_by = $2,
            billing_hold_lift_reason = $3
      WHERE id = $1
      RETURNING billing_hold_lifted_at AS lifted_at`,
    [engagementId, actor.id, input.reason]
  );
  await writeAudit(app.db, {
    actorType: 'staff',
    actorId: actor.id,
    actorLabel: actor.label,
    action: 'engagement.billing_hold_lifted',
    objectType: 'engagement',
    objectId: engagementId,
    contactId: row.contact_id,
    details: { reason: input.reason, held_for: row.billing_hold_reason, service_line: row.service_line },
  });
  return { engagementId, contactId: row.contact_id, liftedAt: rows[0]!.lifted_at.toISOString() };
}
