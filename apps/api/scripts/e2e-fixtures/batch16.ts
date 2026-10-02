/*
 * BATCH 16 (Brian, 2026-10-02) — the fixture for R117 (path I, steps I6-I7), one client per fixture set
 * (narrow, wide): two live 1040s on two engagements, each with a file of the client's on it. The walk
 * withdraws one as the firm's own record and the other as the client's decision, in Ops, and reads the
 * portal. Built through the doors (the contact, the portal invite, the returns); the file rows are
 * inserted as the other harness fixtures insert theirs (no file bytes in MinIO).
 */
import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';

export interface Batch16Person {
  contactId: string; portalMagicTokens: string[];
  dup: { engagementId: string; returnId: string; year: number; fileName: string };
  kept: { engagementId: string; returnId: string; year: number; fileName: string };
}
export type Batch16Fixture = Record<'phone' | 'desk', Batch16Person>;

export async function buildBatch16Fixture(
  app: FastifyInstance,
  deps: { staffToken: string; magicTokens: string[]; magicLinks: string[]; drainOutbox: () => Promise<unknown> }
): Promise<Batch16Fixture> {
  const auth = { authorization: `Bearer ${deps.staffToken}` };
  const post = async <T>(url: string, payload: unknown): Promise<T> => {
    const r = await app.inject({ method: 'POST', url, headers: auth, payload });
    if (r.statusCode >= 300) throw new Error(`batch16 fixture: POST ${url} answered ${r.statusCode} ${r.body}`);
    return r.json() as T;
  };
  const out: Partial<Batch16Fixture> = {};
  for (const key of ['phone', 'desk'] as const) {
    const cap = key === 'phone' ? 'Phone' : 'Desk';
    const c = await post<{ id: string }>('/contacts', { firstName: 'Synthetic', lastName: `Withdrawals${cap}`, email: `withdrawals-${key}@example.test` });
    await app.db.query(`UPDATE contacts SET soto_status = 'active' WHERE id = $1`, [c.id]);
    const before = deps.magicLinks.length;
    await post('/portal-users', { contactId: c.id });
    await deps.drainOutbox();
    const tokens = deps.magicTokens.splice(before);
    deps.magicLinks.splice(before);
    if (tokens.length === 0) throw new Error('batch16 fixture: the portal invite reached no mailer');

    const open = async (year: number, label: string, fileName: string) => {
      const te = await post<{ id: string }>('/tax-engagements', {
        contactId: c.id, taxYear: year, returnType: '1040', clientType: 'individual',
        reason: `Harness fixture (batch 16): the ${label} return.`,
      });
      const eng = (await app.db.query<{ engagement_id: string }>(`SELECT engagement_id FROM tax_engagements WHERE id = $1`, [te.id])).rows[0]!.engagement_id;
      await app.db.query(
        `INSERT INTO documents (contact_id, category, filename, minio_bucket, minio_key, uploaded_by_type, scan_status, tax_engagement_id)
         VALUES ($1, 'tax_documents', $2, 'synthetic', $3, 'client', 'clean', $4)`,
        [c.id, fileName, `harness/${randomBytes(6).toString('hex')}`, te.id]
      );
      return { engagementId: eng, returnId: te.id, year, fileName };
    };
    out[key] = {
      contactId: c.id, portalMagicTokens: tokens,
      dup: await open(2023, 'duplicate', `synthetic-w2-on-the-duplicate-${key}.pdf`),
      kept: await open(2022, "client's", `synthetic-w2-client-withdrew-${key}.pdf`),
    };
  }
  return out as Batch16Fixture;
}
