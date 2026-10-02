/*
 * BATCH 15 (Brian, 2026-09-30) — the fixture for path I, one client per fixture set (narrow, wide):
 *
 *   R110  the portal Documents list by return: a 1040 from an accepted quote (its checklist), a business
 *         1120-S, a file filed against each, a file that counts as one of the 1040's checklist items, a
 *         file tied to no return, and a superseded file that the client must not see;
 *   R108  a withdrawn prior-year 1040 with the reason recorded at the withdrawal;
 *   R107  the 1040 sits in Engage (intake started) with the quote's range, for "Set final fee" in Details.
 *
 * Built through the doors (the quote, the return, the transition, the counts-as function); the file rows
 * are inserted as the other harness fixtures insert theirs (no file bytes in MinIO).
 */
import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import type { AuthedStaff } from '../../src/types.ts';
import { acceptQuote, createQuote, sendQuote } from '../../src/modules/pricing/quotes.ts';
import { countDocumentAs } from '../../src/modules/documents/counts-as.ts';

export interface Batch15Person {
  contactId: string; fullName: string; businessName: string; portalMagicTokens: string[];
  return1040Id: string; return1120sId: string; withdrawnId: string; taxYear: number;
  files: { on1040: string; on1120s: string; countsAs: string; loose: string; superseded: string };
  countsAsLabel: string; withdrawnReason: string;
}
export type Batch15Fixture = Record<'phone' | 'desk', Batch15Person>;

export async function buildBatch15Fixture(
  app: FastifyInstance,
  deps: { staffToken: string; actor: AuthedStaff; magicTokens: string[]; magicLinks: string[]; drainOutbox: () => Promise<unknown> }
): Promise<Batch15Fixture> {
  const auth = { authorization: `Bearer ${deps.staffToken}` };
  const post = async <T>(url: string, payload: unknown): Promise<T> => {
    const r = await app.inject({ method: 'POST', url, headers: auth, payload });
    if (r.statusCode >= 300) throw new Error(`batch15 fixture: POST ${url} answered ${r.statusCode} ${r.body}`);
    return r.json() as T;
  };
  const doc = async (contactId: string, name: string, teId: string | null) => (await app.db.query<{ id: string }>(
    `INSERT INTO documents (contact_id, category, filename, minio_bucket, minio_key, uploaded_by_type, scan_status, tax_engagement_id)
     VALUES ($1, 'tax_documents', $2, 'synthetic', $3, 'client', 'clean', $4) RETURNING id`,
    [contactId, name, `harness/${randomBytes(6).toString('hex')}`, teId]
  )).rows[0]!.id;

  const out: Partial<Batch15Fixture> = {};
  for (const key of ['phone', 'desk'] as const) {
    const cap = key === 'phone' ? 'Phone' : 'Desk';
    const lastName = `Bythereturn${cap}`;
    const c = await post<{ id: string }>('/contacts', { firstName: 'Synthetic', lastName, email: `byreturn-${key}@example.test` });
    await app.db.query(`UPDATE contacts SET soto_status = 'active' WHERE id = $1`, [c.id]);
    const businessName = `Synthetic Byreturn ${cap} Studio LLC`;
    const biz = await post<{ id: string }>(`/contacts/${c.id}/businesses`, { name: businessName, entityType: 's_corp', state: 'IL', ein: key === 'phone' ? '55-5555601' : '55-5555602' });
    const before = deps.magicLinks.length;
    await post('/portal-users', { contactId: c.id });
    await deps.drainOutbox();
    const tokens = deps.magicTokens.splice(before);
    deps.magicLinks.splice(before);
    if (tokens.length === 0) throw new Error('batch15 fixture: the portal invite reached no mailer');

    // The 1040 from an accepted quote: its engagement, return, checklist and deposit.
    const q = await createQuote(app, { contactId: c.id, lines: [{ itemCode: 'IND_BASE_SINGLE' }, { itemCode: 'IND_SCH_B_D' }] }, deps.actor);
    const sent = await sendQuote(app, q.id, deps.actor);
    await acceptQuote(app, sent.url.split('/').pop()!, {});
    const r1040 = await app.db.query<{ id: string; tax_year: number }>(
      `SELECT te.id, te.tax_year FROM tax_engagements te JOIN engagements e ON e.id = te.engagement_id
        WHERE e.contact_id = $1 AND te.return_type = '1040' ORDER BY te.created_at LIMIT 1`, [c.id]
    );
    const te1040 = r1040.rows[0]!;
    // The business return, opened by hand.
    const r1120s = await post<{ id: string }>('/tax-engagements', {
      contactId: c.id, businessId: biz.id, taxYear: te1040.tax_year, returnType: '1120s', clientType: 'business',
      reason: 'Harness fixture (batch 15): the business return the Documents list groups under.',
    });
    // A prior-year 1040, withdrawn with its reason.
    const prior = await post<{ id: string }>('/tax-engagements', {
      contactId: c.id, taxYear: te1040.tax_year - 1, returnType: '1040', clientType: 'individual',
      reason: 'Harness fixture (batch 15): a prior-year return opened, then withdrawn.',
    });
    const withdrawnReason = 'Opened by mistake: the client filed this year with another preparer.';
    await post(`/tax-engagements/${prior.id}/transition`, { toStage: 'withdrawn', withdrawalKind: 'client', note: withdrawnReason });

    const files = {
      on1040: await doc(c.id, `synthetic-w2-employer-${key}.pdf`, te1040.id),
      on1120s: await doc(c.id, `synthetic-1120s-ledger-${key}.pdf`, r1120s.id),
      countsAs: await doc(c.id, `synthetic-1099-int-${key}.pdf`, null),
      loose: await doc(c.id, `synthetic-receipt-${key}.pdf`, null),
      superseded: await doc(c.id, `synthetic-old-scan-${key}.pdf`, te1040.id),
    };
    await app.db.query(`UPDATE documents SET superseded_by = $2, superseded_at = now() WHERE id = $1`, [files.superseded, files.on1040]);
    // The 1099 counts as one of the 1040's checklist items, through the same function the doors use.
    const item = await app.db.query<{ id: string }>(
      `SELECT ri.id FROM document_request_items ri JOIN document_requests dr ON dr.id = ri.request_id
        WHERE dr.tax_engagement_id = $1 AND dr.source = 'checklist' AND ri.status = 'pending' ORDER BY ri.id LIMIT 1`, [te1040.id]
    );
    if (!item.rows[0]) throw new Error('batch15 fixture: the 1040 has no pending checklist item');
    const counted = await countDocumentAs(app, { type: 'staff', id: deps.actor.id, label: deps.actor.fullName }, { documentId: files.countsAs, itemId: item.rows[0].id });

    out[key] = {
      contactId: c.id, fullName: `Synthetic ${lastName}`, businessName, portalMagicTokens: tokens,
      return1040Id: te1040.id, return1120sId: r1120s.id, withdrawnId: prior.id, taxYear: te1040.tax_year,
      files, countsAsLabel: counted.labelEn, withdrawnReason,
    };
  }
  return out as Batch15Fixture;
}
