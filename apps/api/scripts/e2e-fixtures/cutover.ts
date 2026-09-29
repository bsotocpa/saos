/*
 * R90 CUTOVER FACTS (Brian, 2026-09-29) — the fixture for path Z, one pair per viewport.
 *
 *   unconfirmed  a business whose "books current through" the importer wrote from a card last touched
 *                before 2026-09-21: the month is flagged and the bookkeeper holds the confirm task.
 *   selfFiler    a business whose sales-tax card says the client files their own ST-1: no sales-tax
 *                engagement, the fact on the business.
 *
 * Written through the importer's own functions (modules/engagements/import-facts.ts), the way the
 * cutover run writes them; the walk then reads and corrects them on the business page. Synthetic only.
 */
import type { FastifyInstance } from 'fastify';
import type { AuthedStaff } from '../../src/types.ts';
import { makeContact, businessFor } from '../../test/helpers.ts';
import { applyBooksCurrentThrough, applyRecurringServiceFact } from '../../src/modules/engagements/import-facts.ts';

export interface CutoverPair { unconfirmed: { businessId: string; name: string }; selfFiler: { businessId: string; name: string } }
export interface CutoverFixture { phone: CutoverPair; desk: CutoverPair }

export async function buildCutoverFixture(app: FastifyInstance, deps: { actor: AuthedStaff }): Promise<CutoverFixture> {
  const out: Partial<CutoverFixture> = {};
  for (const key of ['phone', 'desk'] as const) {
    const cap = key === 'phone' ? 'Phone' : 'Desk';
    const make = async (kind: string) => {
      const c = await makeContact(app.db, { firstName: 'Synthetic', lastName: `${kind}${cap}`, email: `${kind.toLowerCase()}${key}@example.test` });
      const businessId = await businessFor(app.db, c.id);
      const name = `Synthetic ${kind} ${cap} LLC`;
      await app.db.query(
        `UPDATE businesses SET name = $2, is_test = true, test_note = 'Harness fixture: R90 cutover facts (path Z).' WHERE id = $1`,
        [businessId, name]
      );
      return { contactId: c.id, businessId, name };
    };
    const u = await make('Unconfirmed');
    await applyBooksCurrentThrough(app, {
      businessId: u.businessId, through: '2025-06-30', asOf: '2026-09-25', cardLastActivity: '2026-09-10',
      sourceId: `harness-cutover-bk-${key}`, contactId: u.contactId,
    });
    const s = await make('Selffiler');
    await applyRecurringServiceFact(app, deps.actor, {
      factType: 'sales_tax', sourceId: `harness-cutover-st-${key}`, matchKey: `SYNTHETIC SELFFILER ${cap.toUpperCase()}`, asOf: '2026-09-25',
      appliedBy: 'harness fixture (R90)', sourceTag: 'harness', contactId: s.contactId, businessId: s.businessId,
      values: { frequency: 'quarterly', sales_tax_status: 'client_self_files' }, cardLastActivity: '2026-09-24',
    });
    out[key] = { unconfirmed: { businessId: u.businessId, name: u.name }, selfFiler: { businessId: s.businessId, name: s.name } };
  }
  return out as CutoverFixture;
}
