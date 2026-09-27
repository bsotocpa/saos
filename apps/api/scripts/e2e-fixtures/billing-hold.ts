/*
 * THE BILLING-HOLD FIXTURE (R68, Brian, 2026-09-26): one client per viewport whose sales-tax
 * engagement the Trello importer made — through the importer's OWN function
 * (applyRecurringServiceFact), so the hold on it is the hold the import places, not one the harness
 * stamped. The phone project lifts its client's hold; the desk project lifts the other's; the two
 * projects run in turn against one database.
 *
 * Everything synthetic: a contact with a business, a live sales-tax fact with a monthly frequency.
 */
import type { FastifyInstance } from 'fastify';
import type { AuthedStaff } from '../../src/types.ts';
import { businessFor, makeContact } from '../../test/helpers.ts';
import { applyRecurringServiceFact } from '../../src/modules/engagements/import-facts.ts';

export interface BillingHoldPerson {
  contactId: string;
  businessId: string;
  engagementId: string;
  /** The reason the row carries, as the importer wrote it; the spec reads the badge's title against it. */
  holdReason: string;
}
export interface BillingHoldFixture { phone: BillingHoldPerson; desk: BillingHoldPerson }

const PEOPLE = [
  { key: 'phone' as const, lastName: 'Heldphone', email: 'heldphone@example.test', sourceId: 'harness-st-phone' },
  { key: 'desk' as const, lastName: 'Helddesk', email: 'helddesk@example.test', sourceId: 'harness-st-desk' },
];

export async function buildBillingHoldFixture(app: FastifyInstance, deps: { actor: AuthedStaff }): Promise<BillingHoldFixture> {
  const importer: AuthedStaff = { ...deps.actor, fullName: `${deps.actor.fullName} (trello import rehearsal, harness)` };
  const people: Partial<BillingHoldFixture> = {};
  for (const who of PEOPLE) {
    const contact = await makeContact(app.db, { firstName: 'Synthetic', lastName: who.lastName, email: who.email });
    await app.db.query(
      `UPDATE contacts SET soto_status = 'active', is_test = true, test_note = 'Harness fixture: a sales-tax engagement the Trello importer made, held for billing (R68).' WHERE id = $1`,
      [contact.id]
    );
    const businessId = await businessFor(app.db, contact.id);
    const made = await applyRecurringServiceFact(app, importer, {
      factType: 'sales_tax', sourceId: who.sourceId, matchKey: `SYNTHETIC ${who.lastName.toUpperCase()}`, asOf: '2026-09-19',
      appliedBy: importer.fullName, sourceTag: 'trello_2026-09-19', contactId: contact.id, businessId,
      values: { frequency: 'monthly', closed_or_not_client: false },
    });
    if (made.outcome !== 'applied' || !made.engagementCreated || !made.engagementId) {
      throw new Error(`billing-hold fixture: the importer did not create ${who.lastName}'s sales_tax engagement (${made.outcome})`);
    }
    const { rows } = await app.db.query<{ billing_hold: boolean; billing_hold_reason: string | null }>(
      `SELECT billing_hold, billing_hold_reason FROM engagements WHERE id = $1`, [made.engagementId]);
    if (!rows[0]?.billing_hold || !rows[0].billing_hold_reason) {
      throw new Error(`billing-hold fixture: the importer's engagement for ${who.lastName} is not held — R68's hold is missing at boot`);
    }
    people[who.key] = { contactId: contact.id, businessId, engagementId: made.engagementId, holdReason: rows[0].billing_hold_reason };
  }
  return { phone: people.phone!, desk: people.desk! };
}
