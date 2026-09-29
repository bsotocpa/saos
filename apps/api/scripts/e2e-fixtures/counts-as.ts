/*
 * R96 "COUNTS AS" (Brian, 2026-09-29) — the fixture for path K, one client per viewport.
 *
 * A client with portal access and a 1040 from an accepted quote (its checklist open), and two files
 * already on file under a general category, as a file sent before the checklist existed sits: one the
 * walk matches from Ops, one the client matches in the portal. The files are synthetic rows (clean
 * scan, no bytes: nothing downloads them). Everything else is the walk's taps.
 */
import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import type { AuthedStaff } from '../../src/types.ts';
import { acceptQuote, createQuote, sendQuote } from '../../src/modules/pricing/quotes.ts';

export interface CountsAsPerson { contactId: string; fullName: string; opsDocId: string; portalDocId: string; portalMagicLinks: string[]; portalMagicTokens: string[] }
export interface CountsAsFixture { phone: CountsAsPerson; desk: CountsAsPerson }

export async function buildCountsAsFixture(
  app: FastifyInstance,
  deps: { staffToken: string; actor: AuthedStaff; magicTokens: string[]; magicLinks: string[]; drainOutbox: () => Promise<unknown> }
): Promise<CountsAsFixture> {
  const auth = { authorization: `Bearer ${deps.staffToken}` };
  const post = async <T>(url: string, payload: unknown): Promise<T> => {
    const r = await app.inject({ method: 'POST', url, headers: auth, payload });
    if (r.statusCode >= 300) throw new Error(`counts-as fixture: POST ${url} answered ${r.statusCode} ${r.body}`);
    return r.json() as T;
  };
  const out: Partial<CountsAsFixture> = {};
  for (const key of ['phone', 'desk'] as const) {
    const lastName = `Countsas${key === 'phone' ? 'Phone' : 'Desk'}`;
    const c = await post<{ id: string }>('/contacts', { firstName: 'Synthetic', lastName, email: `${lastName.toLowerCase()}@example.test` });
    await app.db.query(`UPDATE contacts SET soto_status = 'active' WHERE id = $1`, [c.id]);
    const before = deps.magicLinks.length;
    await post('/portal-users', { contactId: c.id });
    await deps.drainOutbox();
    const links = deps.magicLinks.splice(before);
    const tokens = deps.magicTokens.splice(before);
    if (tokens.length === 0) throw new Error('counts-as fixture: the portal invite reached no mailer');
    const q = await createQuote(app, { contactId: c.id, lines: [{ itemCode: 'IND_BASE_SINGLE' }, { itemCode: 'IND_SCH_B_D' }] }, deps.actor);
    const sent = await sendQuote(app, q.id, deps.actor);
    await acceptQuote(app, sent.url.split('/').pop()!, {});
    const doc = async (name: string) => (await app.db.query<{ id: string }>(
      `INSERT INTO documents (contact_id, category, filename, minio_bucket, minio_key, uploaded_by_type, scan_status)
       VALUES ($1, 'tax_documents', $2, 'synthetic', $3, 'client', 'clean') RETURNING id`,
      [c.id, name, `harness/${randomBytes(6).toString('hex')}`]
    )).rows[0]!.id;
    out[key] = {
      contactId: c.id, fullName: `Synthetic ${lastName}`, portalMagicLinks: links, portalMagicTokens: tokens,
      opsDocId: await doc('synthetic-sent-before-the-checklist.pdf'),
      portalDocId: await doc('synthetic-client-file.pdf'),
    };
  }
  return out as CountsAsFixture;
}
