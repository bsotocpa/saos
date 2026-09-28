/*
 * THE RETURNING CLIENT'S NEW ENGAGEMENT (Brian, 2026-09-27, R87) — one client per viewport.
 *
 * Brian's own shape: a client whose Master is signed and who answered the §7216 USE consent for an
 * earlier tax engagement, with portal access. The walk (ops-consent-new-engagement.spec.ts) sends a new
 * 1040 quote for another tax year, the client accepts it in the portal, and the consent for the new
 * engagement must be signable from Home the moment the engagement opens.
 *
 * Built through the doors the API has: the contact and the portal invite through the staff routes, the
 * first engagement by hand with its reason, the packet and its signature through the packet functions,
 * the consent through the same function the portal's POST calls. Synthetic people only.
 */
import type { FastifyInstance } from 'fastify';
import type { AuthedStaff } from '../../src/types.ts';
import { createPacket, recordMasterSignature } from '../../src/modules/engagements/packet.ts';
import { recordConsentAnswer } from '../../src/modules/compliance/consent-presentation.ts';

export interface ConsentPerson {
  contactId: string;
  fullName: string;
  lastName: string;
  firstEngagementId: string;
  /** The tax year of the earlier engagement; the walk quotes the year before it. */
  firstYear: number;
  /** Single use: [0] the walk's portal session. */
  portalMagicTokens: string[];
  portalMagicLinks: string[];
}
export interface ConsentFixture { phone: ConsentPerson; desk: ConsentPerson; item: { code: string; name: string } }

export async function buildConsentFixture(
  app: FastifyInstance,
  deps: { staffToken: string; actor: AuthedStaff; magicTokens: string[]; magicLinks: string[]; drainOutbox: () => Promise<unknown>; taxYear: number }
): Promise<ConsentFixture> {
  const auth = { authorization: `Bearer ${deps.staffToken}` };
  const post = async <T>(url: string, payload: unknown): Promise<T> => {
    const r = await app.inject({ method: 'POST', url, headers: auth, payload });
    if (r.statusCode >= 300) throw new Error(`consent fixture: POST ${url} answered ${r.statusCode} ${r.body}`);
    return r.json() as T;
  };
  const out: Partial<ConsentFixture> = {};
  // The 1040 base line the walk quotes, named from the book in force (never priced here).
  const { rows: items } = await app.db.query<{ item_code: string; name_en: string }>(
    `SELECT pbi.item_code, pbi.name_en FROM price_book_items pbi JOIN price_book_versions v ON v.id = pbi.version_id
      WHERE pbi.item_code = 'IND_BASE_SINGLE' AND pbi.is_active
        AND v.effective_from <= CURRENT_DATE AND (v.effective_to IS NULL OR v.effective_to > CURRENT_DATE)`);
  if (!items[0]) throw new Error('consent fixture: the book in force has no IND_BASE_SINGLE');
  out.item = { code: items[0].item_code, name: items[0].name_en };
  for (const key of ['phone', 'desk'] as const) {
    const lastName = key === 'phone' ? 'Consentphone' : 'Consentdesk';
    const contact = await post<{ id: string }>('/contacts', { firstName: 'Synthetic', lastName, email: `${lastName.toLowerCase()}@example.test` });
    const before = deps.magicTokens.length;
    await post('/portal-users', { contactId: contact.id });
    await deps.drainOutbox();
    const tokens = deps.magicTokens.splice(before);
    const links = deps.magicLinks.splice(before);
    if (tokens.length === 0) throw new Error('consent fixture: the portal invite reached no mailer');
    const first = await post<{ id: string; engagementId?: string }>('/tax-engagements', {
      contactId: contact.id, taxYear: deps.taxYear, returnType: '1040', clientType: 'individual',
      reason: 'Harness fixture: the earlier engagement of a returning client; no quote stands behind it.',
    });
    const eng = await app.db.query<{ engagement_id: string }>(`SELECT engagement_id FROM tax_engagements WHERE id = $1`, [first.id]);
    const firstEngagementId = eng.rows[0]!.engagement_id;
    const packet = await createPacket(app, contact.id, deps.actor);
    await recordMasterSignature(app, packet.packetId);
    await recordConsentAnswer(app, contact.id, '7216_use', true, { engagementId: firstEngagementId });
    out[key] = {
      contactId: contact.id, fullName: `Synthetic ${lastName}`, lastName, firstEngagementId, firstYear: deps.taxYear,
      portalMagicTokens: tokens, portalMagicLinks: links,
    };
  }
  return out as ConsentFixture;
}
