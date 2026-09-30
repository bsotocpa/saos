/*
 * R102 RETURNS WITH NO PREPARER (Brian, 2026-09-30) — the fixture for path J, one return per viewport.
 *
 * The harness has one active tax_preparer, and a return opened with no preparer named goes to the
 * sole one at creation (pipeline.ts soleActiveTaxPreparerId). A return assigned to nobody arises in
 * production when there is no sole preparer (or from an import); here it is opened through the door
 * and its preparer then cleared, the state R102 makes visible. The client is not a test record: the
 * executive count leaves test clients out, as it does for every report. The walk counts, lists,
 * alerts (through the harness's ladder door, on the day two business days later) and assigns.
 */
import type { FastifyInstance } from 'fastify';
import { makeContact } from '../../test/helpers.ts';

export interface NoPreparerReturn { contactId: string; taxEngagementId: string; lastName: string; taxYear: number }
export interface NoPreparerFixture { phone: NoPreparerReturn; desk: NoPreparerReturn }

export async function buildNoPreparerFixture(app: FastifyInstance, deps: { staffToken: string; taxYear: number }): Promise<NoPreparerFixture> {
  const out: Partial<NoPreparerFixture> = {};
  for (const key of ['phone', 'desk'] as const) {
    const lastName = `Noprep${key === 'phone' ? 'Phone' : 'Desk'}`;
    const c = await makeContact(app.db, { firstName: 'Synthetic', lastName, email: `noprep-${key}@example.test` });
    const r = await app.inject({
      method: 'POST', url: '/tax-engagements', headers: { authorization: `Bearer ${deps.staffToken}` },
      payload: { contactId: c.id, taxYear: deps.taxYear, returnType: '1040', clientType: 'individual', reason: 'Harness fixture: a return assigned to nobody (R102, path J).' },
    });
    if (r.statusCode >= 300) throw new Error(`No-preparer fixture: POST /tax-engagements answered ${r.statusCode} ${r.body}`);
    const teId = String((r.json() as { id: string }).id);
    await app.db.query(`UPDATE tax_engagements SET preparer_id = NULL WHERE id = $1`, [teId]);
    out[key] = { contactId: c.id, taxEngagementId: teId, lastName, taxYear: deps.taxYear };
  }
  return out as NoPreparerFixture;
}
