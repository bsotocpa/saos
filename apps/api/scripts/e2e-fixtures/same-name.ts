/*
 * R97 SAME-NAME PAIRS (Brian, 2026-09-29) — the fixture for path C, two pairs per viewport.
 *
 * Each pair is two synthetic records with one name, each holding a task (so neither is the empty
 * record the pass would archive), and an open suggestion between them: the state the pass leaves a
 * pair in. The pass itself is proven in same-name.spec.ts; it is not run here, because over the whole
 * harness database it would answer other walks' records too. The walk merges one pair and dismisses
 * the other, through Compare.
 */
import type { FastifyInstance } from 'fastify';
import { makeContact } from '../../test/helpers.ts';
import { createTask } from '../../src/modules/tasks/service.ts';

export interface SameNamePair { a: string; b: string; name: string }
export interface SameNameFixture { phone: { merge: SameNamePair; dismiss: SameNamePair }; desk: { merge: SameNamePair; dismiss: SameNamePair } }

export async function buildSameNameFixture(app: FastifyInstance): Promise<SameNameFixture> {
  const out: Partial<SameNameFixture> = {};
  for (const key of ['phone', 'desk'] as const) {
    const cap = key === 'phone' ? 'Phone' : 'Desk';
    const pair = async (kind: string): Promise<SameNamePair> => {
      const last = `Same${kind}${cap}`;
      const ids: string[] = [];
      for (const n of [1, 2]) {
        const c = await makeContact(app.db, { firstName: 'Synthetic', lastName: last, email: `same${kind.toLowerCase()}${key}${n}@example.test` });
        await createTask(app, { title: `Synthetic work ${n} for ${last}`, contactId: c.id });
        ids.push(c.id);
      }
      const [a, b] = ids[0]! < ids[1]! ? [ids[0]!, ids[1]!] : [ids[1]!, ids[0]!];
      await app.db.query(`INSERT INTO contact_duplicate_suggestions (a_contact_id, b_contact_id) VALUES ($1, $2)`, [a, b]);
      return { a: ids[0]!, b: ids[1]!, name: `Synthetic ${last}` };
    };
    out[key] = { merge: await pair('merge'), dismiss: await pair('dismiss') };
  }
  return out as SameNameFixture;
}
