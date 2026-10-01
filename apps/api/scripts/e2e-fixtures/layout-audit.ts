/*
 * R106 LAYOUT AUDIT (Brian, 2026-09-30) — one portal client per audit project (375, 768 and 1440 in
 * Chromium and WebKit), each holding the state the pages render at their fullest: an accepted 1040
 * quote (engagement, return, checklist, deposit invoice), two documents, a business, and a portal
 * sign-in link of their own (a link is single use). The audit visits every Ops and portal page with
 * these records and runs the layout check (apps/e2e/tests/layout-check.ts) on each.
 */
import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import type { AuthedStaff } from '../../src/types.ts';
import { acceptQuote, createQuote, sendQuote } from '../../src/modules/pricing/quotes.ts';

export const LAYOUT_PROJECTS = ['chromium-375', 'chromium-768', 'chromium-1440', 'webkit-375', 'webkit-768', 'webkit-1440'] as const;
export interface LayoutPerson { contactId: string; businessId: string; quoteId: string; taxEngagementId: string | null; portalMagicTokens: string[] }
export type LayoutAuditFixture = Record<(typeof LAYOUT_PROJECTS)[number], LayoutPerson>;

export async function buildLayoutAuditFixture(
  app: FastifyInstance,
  deps: { staffToken: string; actor: AuthedStaff; magicTokens: string[]; magicLinks: string[]; drainOutbox: () => Promise<unknown> }
): Promise<LayoutAuditFixture> {
  const auth = { authorization: `Bearer ${deps.staffToken}` };
  const post = async <T>(url: string, payload: unknown): Promise<T> => {
    const r = await app.inject({ method: 'POST', url, headers: auth, payload });
    if (r.statusCode >= 300) throw new Error(`layout-audit fixture: POST ${url} answered ${r.statusCode} ${r.body}`);
    return r.json() as T;
  };
  const out: Partial<LayoutAuditFixture> = {};
  for (const key of LAYOUT_PROJECTS) {
    const tag = key.replace(/[^a-z0-9]/g, '');
    const lastName = `Layout${tag.charAt(0).toUpperCase()}${tag.slice(1)}`;
    const c = await post<{ id: string }>('/contacts', { firstName: 'Synthetic', lastName, email: `layout-${key}@example.test` });
    await app.db.query(`UPDATE contacts SET soto_status = 'active' WHERE id = $1`, [c.id]);
    const biz = await post<{ id: string }>(`/contacts/${c.id}/businesses`, { name: `Synthetic Layout ${lastName} Studio, LLC`, entityType: 'llc', state: 'IL' });
    const before = deps.magicLinks.length;
    await post('/portal-users', { contactId: c.id });
    await deps.drainOutbox();
    const tokens = deps.magicTokens.splice(before);
    deps.magicLinks.splice(before);
    if (tokens.length === 0) throw new Error('layout-audit fixture: the portal invite reached no mailer');
    const q = await createQuote(app, { contactId: c.id, lines: [{ itemCode: 'IND_BASE_SINGLE' }, { itemCode: 'IND_SCH_B_D' }] }, deps.actor);
    const sent = await sendQuote(app, q.id, deps.actor);
    await acceptQuote(app, sent.url.split('/').pop()!, {});
    for (const name of ['synthetic-w2-employer-statement.pdf', 'synthetic-1099-int-brokerage-statement-long-name.pdf']) {
      await app.db.query(
        `INSERT INTO documents (contact_id, category, filename, minio_bucket, minio_key, uploaded_by_type, scan_status)
         VALUES ($1, 'tax_documents', $2, 'synthetic', $3, 'client', 'clean')`,
        [c.id, name, `harness/${randomBytes(6).toString('hex')}`]
      );
    }
    const te = await app.db.query<{ id: string }>(
      `SELECT te.id FROM tax_engagements te JOIN engagements e ON e.id = te.engagement_id WHERE e.contact_id = $1 LIMIT 1`, [c.id]
    );
    out[key] = { contactId: c.id, businessId: biz.id, quoteId: q.id, taxEngagementId: te.rows[0]?.id ?? null, portalMagicTokens: tokens };
  }
  return out as LayoutAuditFixture;
}
