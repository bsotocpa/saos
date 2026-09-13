/*
 * SAME-NAME BUSINESSES ON ONE CONTACT (2026-09-14, Brian's ruling 5).
 *
 *   Two businesses on one record whose names differ only by case or spacing are one business;
 *   the row with an EIN wins, then an entity type, then the older row. A protected name is
 *   listed first and merged only when a person names the losing row. Synthetic data only.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import { createTestConfig, makeContact, makeStaff, type TestStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';
import { sameNameBusinessesWithinContact, applyBusinessDedupe } from '../src/modules/crm/businesses.ts';

let app: FastifyInstance;
let config: Config;
let brian: TestStaff;
const actor = () => ({ id: brian.id, email: brian.email, fullName: `${brian.fullName} (ruled 2026-09-14, applied by script)` });

before(async () => {
  config = await createTestConfig('bizdedupe');
  app = buildServer(config);
  await app.ready();
  brian = await makeStaff(app.db, config, { email: 'brian-bizdedupe@example.test', name: 'Synthetic ceo', role: 'ceo', password: 'ceo-password-123456' });
});
after(async () => { await app.close(); });

async function business(contactId: string, name: string, extra: { ein?: string; entityType?: string } = {}): Promise<string> {
  const { rows } = await app.db.query<{ id: string }>(
    `INSERT INTO businesses (name, ein, entity_type) VALUES ($1, $2, $3::business_entity_type) RETURNING id`,
    [name, extra.ein ?? null, extra.entityType ?? null]);
  await app.db.query(`INSERT INTO business_members (business_id, contact_id, member_role, is_primary) VALUES ($1, $2, 'owner', false)`, [rows[0]!.id, contactId]);
  return rows[0]!.id;
}

test('case and spacing do not make two businesses: the row with the EIN wins, the other is merged into it; a protected name waits for a person', async () => {
  const erica = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Condo', email: 'condo-bizdedupe@example.test' });
  const upper = await business(erica.id, 'TRI-TAYLOR CONDOMINIUM ASSOCIATION');
  const mixed = await business(erica.id, 'Tri-Taylor  Condominium Association', { ein: '12-3456789' });
  const other = await business(erica.id, 'Tri-Taylor Management LLC', { entityType: 'llc' });
  // Two different contacts with the same-named business are not a pair.
  const neighbour = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Neighbour', email: 'neighbour-bizdedupe@example.test' });
  await business(neighbour.id, 'TRI-TAYLOR CONDOMINIUM ASSOCIATION');
  // A protected name.
  const joseph = await makeContact(app.db, { firstName: 'Joseph', lastName: 'Basilone', email: 'basilone-bizdedupe@example.test' });
  const jb1 = await business(joseph.id, 'Thrift & Thrive Inc');
  const jb2 = await business(joseph.id, 'THRIFT & THRIVE INC');

  const groups = await sameNameBusinessesWithinContact(app);
  assert.equal(groups[0]!.protectedName, true, 'the protected name sorts first');
  assert.equal(groups[0]!.contactName, 'Joseph Basilone');
  const condo = groups.find((g) => g.contactId === erica.id)!;
  assert.equal(condo.businesses.length, 2, 'the management company is a different business');
  assert.equal(condo.winnerId, mixed, 'the row with the EIN wins');
  assert.deepEqual(condo.loserIds, [upper]);
  assert.equal(groups.filter((g) => g.contactId === neighbour.id).length, 0, 'a same-named business on another contact is not a pair');
  void other;

  const results = await applyBusinessDedupe(app, groups, actor(), { reason: 'The same business entered twice by the import, differing only in capitalisation; one entity' });
  assert.deepEqual(results.map((r) => [r.contactName, r.merged, r.held !== null]), [['Joseph Basilone', false, true], ['Synthetic Condo', true, false]]);
  const lost = await app.db.query<{ is_archived: boolean; merged_into_business_id: string }>(`SELECT is_archived, merged_into_business_id FROM businesses WHERE id = $1`, [upper]);
  assert.equal(lost.rows[0]!.is_archived, true);
  assert.equal(lost.rows[0]!.merged_into_business_id, mixed);
  assert.equal((await app.db.query(`SELECT 1 FROM business_members WHERE business_id = $1`, [upper])).rows.length, 0, 'the shared membership collapsed onto the winner');
  assert.equal((await app.db.query<{ is_archived: boolean }>(`SELECT is_archived FROM businesses WHERE id = $1`, [jb2])).rows[0]!.is_archived, false, 'nothing touched the protected record');

  const approved = await applyBusinessDedupe(app, await sameNameBusinessesWithinContact(app), actor(), { reason: 'The same business entered twice by the import, differing only in capitalisation; one entity', approvedLoserIds: new Set([jb2]) });
  assert.deepEqual(approved.map((r) => [r.contactName, r.merged]), [['Joseph Basilone', true]]);
  assert.equal((await app.db.query<{ merged_into_business_id: string }>(`SELECT merged_into_business_id FROM businesses WHERE id = $1`, [jb2])).rows[0]!.merged_into_business_id, jb1);
  assert.deepEqual(await sameNameBusinessesWithinContact(app), [], 'nothing left to merge');
});
