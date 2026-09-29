/*
 * BATCH 10 FIXTURES (Brian, 2026-09-29) — one client of each kind per viewport.
 *
 *   backfill  R91: a 1040 opened from an accepted quote, standing as a return accepted before migration
 *             0132 stands: no checklist. (The acceptance opens one now; the fixture removes it, the only
 *             way to build that past on a fresh database.) The walk presses the backfill door on its row.
 *   overdue   R93: a return opened by hand whose original deadline was 20 days ago, no extension, not
 *             filed, with portal access. The walk reads "Overdue since" on the Ops row, the queue and the
 *             portal card, records the extension, and reads it gone. The tax year is the current one, so
 *             the extended deadline the route derives is always ahead, whatever day the harness runs.
 *   merge     R92: two records of one synthetic person sharing a phone; the one with the portal sign-in
 *             is the survivor by rule. The walk merges them through the pair door and opens the
 *             retired record's page, which lands on the survivor.
 *
 * Through the doors the API has: contacts, the portal invite and the hand-opened return through the
 * staff routes; the quote through the quote functions. Synthetic people only.
 */
import type { FastifyInstance } from 'fastify';
import type { AuthedStaff } from '../../src/types.ts';
import { acceptQuote, createQuote, sendQuote } from '../../src/modules/pricing/quotes.ts';
import { addDays, todayChicago } from '../../src/modules/tax/deadlines.ts';

export interface BackfillPerson { contactId: string; fullName: string; taxEngagementId: string }
export interface OverduePerson { contactId: string; fullName: string; taxEngagementId: string; engagementId: string; overdueSince: string; portalMagicTokens: string[] }
export interface MergePair { lastName: string; withPortal: string; withoutPortal: string }
export interface Batch10Fixture {
  phone: { backfill: BackfillPerson; overdue: OverduePerson; merge: MergePair };
  desk: { backfill: BackfillPerson; overdue: OverduePerson; merge: MergePair };
}

export async function buildBatch10Fixture(
  app: FastifyInstance,
  deps: { staffToken: string; actor: AuthedStaff; magicTokens: string[]; magicLinks: string[]; drainOutbox: () => Promise<unknown>; preparerId: string }
): Promise<Batch10Fixture> {
  const auth = { authorization: `Bearer ${deps.staffToken}` };
  const post = async <T>(url: string, payload: unknown): Promise<T> => {
    const r = await app.inject({ method: 'POST', url, headers: auth, payload });
    if (r.statusCode >= 300) throw new Error(`batch10 fixture: POST ${url} answered ${r.statusCode} ${r.body}`);
    return r.json() as T;
  };
  const today = todayChicago();
  const out: Partial<Batch10Fixture> = {};
  for (const key of ['phone', 'desk'] as const) {
    const cap = key === 'phone' ? 'Phone' : 'Desk';
    // ── R91: the return from a quote accepted before the checklist existed ──
    const bLast = `Backfill${cap}`;
    const bContact = await post<{ id: string }>('/contacts', { firstName: 'Synthetic', lastName: bLast, email: `${bLast.toLowerCase()}@example.test` });
    await app.db.query(`UPDATE contacts SET soto_status = 'active' WHERE id = $1`, [bContact.id]);
    const q = await createQuote(app, { contactId: bContact.id, lines: [{ itemCode: 'IND_BASE_SINGLE' }, { itemCode: 'IND_SCH_B_D' }] }, deps.actor);
    const sent = await sendQuote(app, q.id, deps.actor);
    await acceptQuote(app, sent.url.split('/').pop()!, {});
    const bte = await app.db.query<{ id: string }>(
      `SELECT te.id FROM tax_engagements te JOIN engagements e ON e.id = te.engagement_id WHERE e.contact_id = $1 ORDER BY te.created_at DESC LIMIT 1`,
      [bContact.id]
    );
    if (!bte.rows[0]) throw new Error('batch10 fixture: the accepted quote opened no return');
    await app.db.query(`DELETE FROM document_requests WHERE tax_engagement_id = $1 AND source = 'checklist'`, [bte.rows[0].id]);

    // ── R93: the overdue return ──
    const oLast = `Overdue${cap}`;
    const oContact = await post<{ id: string }>('/contacts', { firstName: 'Synthetic', lastName: oLast, email: `${oLast.toLowerCase()}@example.test` });
    const before = deps.magicTokens.length;
    await post('/portal-users', { contactId: oContact.id });
    await deps.drainOutbox();
    const tokens = deps.magicTokens.splice(before);
    deps.magicLinks.splice(before);
    if (tokens.length === 0) throw new Error('batch10 fixture: the portal invite reached no mailer');
    const ote = await post<{ id: string }>('/tax-engagements', {
      contactId: oContact.id, taxYear: Number(today.slice(0, 4)), returnType: '1040', clientType: 'individual',
      reason: 'Harness fixture: a return past its original deadline with no extension (R93); no quote stands behind it.',
    });
    const overdueSince = addDays(today, -20);
    await app.db.query(`UPDATE tax_engagements SET original_deadline = $2::date, preparer_id = $3 WHERE id = $1`, [ote.id, overdueSince, deps.preparerId]);
    const oEng = await app.db.query<{ engagement_id: string }>(`SELECT engagement_id FROM tax_engagements WHERE id = $1`, [ote.id]);

    // ── R92: the pair the walk merges ──
    const mLast = `Mergepair${cap}`;
    const m1 = await post<{ id: string }>('/contacts', { firstName: 'Synthetic', lastName: mLast, email: `${mLast.toLowerCase()}-one@example.test` });
    const m2 = await post<{ id: string }>('/contacts', { firstName: 'Synthetic', lastName: mLast, email: `${mLast.toLowerCase()}-two@example.test` });
    await app.db.query(`UPDATE contacts SET phone = $2 WHERE id = ANY($1::uuid[])`, [[m1.id, m2.id], key === 'phone' ? '+13125550188' : '+13125550189']);
    await app.db.query(`INSERT INTO portal_users (contact_id, email) VALUES ($1, $2)`, [m2.id, `${mLast.toLowerCase()}-two@example.test`]);

    out[key] = {
      merge: { lastName: mLast, withPortal: m2.id, withoutPortal: m1.id },
      backfill: { contactId: bContact.id, fullName: `Synthetic ${bLast}`, taxEngagementId: bte.rows[0].id },
      overdue: {
        contactId: oContact.id, fullName: `Synthetic ${oLast}`, taxEngagementId: ote.id, engagementId: oEng.rows[0]!.engagement_id,
        overdueSince, portalMagicTokens: tokens,
      },
    };
  }
  return out as Batch10Fixture;
}
