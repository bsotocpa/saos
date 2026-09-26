/*
 * THE PORTAL AFTER SIGNING (R46, Brian, 2026-09-26): one client per viewport whose signature envelopes
 * are the production shape that put a signed document under "Waiting for your signature":
 *
 *   a withdrawn 1040        opened by hand through POST /tax-engagements (a reason), an engagement
 *                           letter envelope queued on it through POST /signature-envelopes, then the
 *                           engagement withdrawn through POST /engagements/:id/close. Its letter must
 *                           never reach the portal.
 *   an accepted 1120-S      the quote built, sent and accepted through the pricing service the way
 *                           the walk's client accepts one; the acceptance makes the live engagement,
 *                           its scope snapshot (Schedule B comes from that line — R46) and the return.
 *   two letters on it       two engagement_letter envelopes on the live engagement, the duplicate the
 *                           page used to print twice. They fold into one row and complete with the
 *                           Master signature.
 *   the packet              created and sent through the Ops doors; the CLIENT signs it in the spec
 *                           (P2 is a tap), then reads the home and the sign page.
 *
 * Two sign-in links per person ([0] the spec's session, [1] a spare), inside the throttle. Everything
 * synthetic; the harness database is local.
 */
import type { FastifyInstance } from 'fastify';
import { makeContact } from '../../test/helpers.ts';
import { acceptQuote, createQuote, sendQuote } from '../../src/modules/pricing/quotes.ts';
import type { AuthedStaff } from '../../src/types.ts';

export interface SigningPerson {
  contactId: string;
  ownerEmail: string;
  businessName: string;
  taxYear: number;
  liveEngagementId: string;
  withdrawnEngagementId: string;
  packetId: string;
  /** Single use: [0] the spec's session, [1] the spare. */
  portalMagicTokens: string[];
  portalMagicLinks: string[];
}
export interface SigningFixture { phone: SigningPerson; desk: SigningPerson }

export interface SigningDeps {
  staffToken: string;
  actor: AuthedStaff;
  magicTokens: string[];
  magicLinks: string[];
  drainOutbox: () => Promise<unknown>;
}

const PEOPLE = [
  { key: 'phone' as const, lastName: 'Signphone', email: 'signphone@example.test', business: 'Harness Signing Phone Corp, LLC', ein: '55-5555571' },
  { key: 'desk' as const, lastName: 'Signdesk', email: 'signdesk@example.test', business: 'Harness Signing Desk Corp, LLC', ein: '55-5555572' },
];

export async function buildSigningFixture(app: FastifyInstance, deps: SigningDeps): Promise<SigningFixture> {
  const { staffToken, actor, magicTokens, magicLinks, drainOutbox } = deps;
  const auth = { authorization: `Bearer ${staffToken}` };

  const post = async <T>(url: string, payload: unknown, expect = 201): Promise<T> => {
    const r = await app.inject({ method: 'POST', url, headers: auth, payload });
    if (r.statusCode !== expect) throw new Error(`signing fixture: POST ${url} answered ${r.statusCode} ${r.body}`);
    return r.json() as T;
  };
  /** The links a request left with the mailer, taken back out so E2E_READY's own slice is untouched. */
  const tokensFrom = async (request: () => Promise<number>): Promise<{ tokens: string[]; links: string[] }> => {
    const before = magicTokens.length;
    const status = await request();
    if (status >= 300) throw new Error(`signing fixture: a sign-in link was refused with ${status}`);
    await drainOutbox();
    return { tokens: magicTokens.splice(before), links: magicLinks.splice(before) };
  };

  // The business-tax base line in force, by its service line: the item code is data, never a price.
  const { rows: bizItems } = await app.db.query<{ item_code: string }>(
    `SELECT pbi.item_code FROM price_book_items pbi JOIN price_book_versions v ON v.id = pbi.version_id
      WHERE pbi.service_line = 'business_tax' AND pbi.is_active AND pbi.display_on_quote AND pbi.amount_cents IS NOT NULL
        AND v.effective_from <= CURRENT_DATE AND (v.effective_to IS NULL OR v.effective_to > CURRENT_DATE)
      ORDER BY (pbi.item_code = 'BIZ_1120S') DESC, pbi.item_code LIMIT 1`
  );
  const bizItem = bizItems[0];
  if (!bizItem) throw new Error('signing fixture: the price book in force carries no business-tax base line');

  const people: Partial<SigningFixture> = {};
  for (const who of PEOPLE) {
    const contact = await makeContact(app.db, { firstName: 'Synthetic', lastName: who.lastName, email: who.email });
    await app.db.query(
      `UPDATE contacts SET soto_status = 'active', is_test = true, test_note = 'Harness fixture: the portal after signing (R46).' WHERE id = $1`,
      [contact.id]
    );
    const biz = await post<{ id: string }>(`/contacts/${contact.id}/businesses`, { name: who.business, ein: who.ein, entityType: 's_corp', state: 'IL' });

    // 'Grant access' (link one) and one spare.
    const granted = await tokensFrom(async () => (await app.inject({ method: 'POST', url: '/portal-users', headers: auth, payload: { contactId: contact.id } })).statusCode);
    const spare = await tokensFrom(async () => (await app.inject({ method: 'POST', url: '/portal/auth/magic/request', payload: { email: who.email } })).statusCode);
    const portalMagicTokens = [...granted.tokens, ...spare.tokens];
    const portalMagicLinks = [...granted.links, ...spare.links];
    if (portalMagicTokens.length < 2) throw new Error(`signing fixture: only ${portalMagicTokens.length} sign-in link(s) reached the mailer for ${who.lastName}`);

    // The withdrawn 1040 with its queued letter: an older year, so it cannot collide with the quoted return.
    const withdrawnReturn = await post<{ id: string }>('/tax-engagements', {
      reason: 'Return opened by hand for the signing fixture; withdrawn below, the way the production 1040s were',
      contactId: contact.id, taxYear: 2023, returnType: '1040', title: 'Harness signing: the withdrawn 1040',
    });
    const withdrawnEngagementId = (await app.db.query<{ engagement_id: string }>(`SELECT engagement_id FROM tax_engagements WHERE id = $1`, [withdrawnReturn.id])).rows[0]!.engagement_id;
    await post('/signature-envelopes', { contactId: contact.id, type: 'engagement_letter', engagementId: withdrawnEngagementId, taxEngagementId: withdrawnReturn.id, serviceLine: 'tax' });
    await post(`/engagements/${withdrawnEngagementId}/close`, { outcome: 'withdrawn', reason: 'Harness fixture: the client did not proceed with this year' }, 200);

    // The accepted 1120-S quote: the live engagement, its scope (Schedule B) and its return.
    const quote = await createQuote(app, { contactId: contact.id, businessId: biz.id, lines: [{ itemCode: bizItem.item_code }] }, actor);
    const sentQuote = await sendQuote(app, quote.id, actor);
    await drainOutbox();
    const accepted = await acceptQuote(app, sentQuote.url.split('/').pop()!, {});
    await drainOutbox();
    const liveEngagementId = accepted.engagementId;
    const liveReturn = await app.db.query<{ id: string; tax_year: number }>(`SELECT id, tax_year FROM tax_engagements WHERE engagement_id = $1`, [liveEngagementId]);
    if (!liveReturn.rows[0]) throw new Error('signing fixture: the accepted 1120-S quote opened no return record');
    // Two letters on the live engagement: the duplicate row.
    for (let i = 0; i < 2; i++) {
      await post('/signature-envelopes', { contactId: contact.id, type: 'engagement_letter', engagementId: liveEngagementId, taxEngagementId: liveReturn.rows[0].id, serviceLine: 'tax' });
    }

    // The packet, created and sent through the Ops doors; the client signs it in the spec.
    const packet = await post<{ packetId: string; scheduleCodes: string[] }>(`/contacts/${contact.id}/packet`, {}, 200);
    if (packet.scheduleCodes.join(',') !== 'B') throw new Error(`signing fixture: the packet carries ${packet.scheduleCodes.join(',')}; R46 says the accepted 1120-S line is B alone`);
    await post(`/packets/${packet.packetId}/send`, {}, 200);
    await drainOutbox();

    people[who.key] = {
      contactId: contact.id, ownerEmail: who.email, businessName: who.business, taxYear: liveReturn.rows[0].tax_year,
      liveEngagementId, withdrawnEngagementId, packetId: packet.packetId, portalMagicTokens, portalMagicLinks,
    };
  }
  return { phone: people.phone!, desk: people.desk! };
}
