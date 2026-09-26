/*
 * THE DOCUMENTS PAGE FIXTURE (R49, Brian, 2026-09-26): one client per viewport whose Documents
 * page carries the three kinds of row a real account carries, so the harness reads the page
 * Brian's own account crashed on.
 *
 *   the signed agreement copy   the engagement letter signed across the desk, filed by staff
 *                               through POST /documents under signed_authorizations with the
 *                               date the client signed (the Ops door, multipart, the walker's
 *                               own token). This is the row shape on Brian's account: category
 *                               signed_authorizations, tax_year null.
 *   the delivered return        the return PDF, filed through the same door under
 *                               return_deliverable with its year (Deliver Return). The second
 *                               row shape on Brian's account.
 *   the client upload           NOT built here. The spec uploads it through the page's own file
 *                               control (G1 is a tap), and only its file name is declared here so
 *                               the walk and the reads agree on what to look for.
 *
 * Each person gets two sign-in links, one per spec test ([0] the three kinds, [1] the boundary),
 * inside the three-per-ten-minutes throttle. Everything synthetic; the harness database is local.
 */
import type { FastifyInstance } from 'fastify';
import { makeContact, multipartBody } from '../../test/helpers.ts';
import { defaultTaxYear } from '../../src/modules/engagements/period.ts';
import { todayChicago } from '../../src/modules/tax/deadlines.ts';

export interface DocumentsPerson {
  contactId: string;
  taxEngagementId: string;
  taxYear: number;
  /** Single use, one per test: [0] the three kinds (G1), [1] the error boundary (G2). */
  portalMagicTokens: string[];
  portalMagicLinks: string[];
  markers: { signedLetter: string; returnFile: string; clientUpload: string };
}
export interface DocumentsFixture { phone: DocumentsPerson; desk: DocumentsPerson }

export interface DocumentsDeps {
  staffToken: string;
  magicTokens: string[];
  magicLinks: string[];
  drainOutbox: () => Promise<unknown>;
}

const PEOPLE = [
  { key: 'phone' as const, lastName: 'Docsphone', email: 'docsphone@example.test' },
  { key: 'desk' as const, lastName: 'Docsdesk', email: 'docsdesk@example.test' },
];
const PDF = Buffer.from('%PDF-1.4 synthetic harness document (R49) — no real client data\n%%EOF');

export async function buildDocumentsFixture(app: FastifyInstance, deps: DocumentsDeps): Promise<DocumentsFixture> {
  const { staffToken, magicTokens, magicLinks, drainOutbox } = deps;
  const auth = { authorization: `Bearer ${staffToken}` };
  const taxYear = defaultTaxYear(todayChicago());

  /** The links a request left with the mailer, taken back out so E2E_READY's own slice is untouched. */
  const tokensFrom = async (request: () => Promise<number>): Promise<{ tokens: string[]; links: string[] }> => {
    const before = magicTokens.length;
    const status = await request();
    if (status >= 300) throw new Error(`documents fixture: a sign-in link was refused with ${status}`);
    await drainOutbox();
    return { tokens: magicTokens.splice(before), links: magicLinks.splice(before) };
  };

  /** The Ops upload door, the way the Deliver Return page and the client page call it. */
  const fileAs = async (fields: Record<string, string>, filename: string): Promise<string> => {
    const { payload, headers } = multipartBody(fields, { field: 'file', filename, contentType: 'application/pdf', data: PDF });
    const res = await app.inject({ method: 'POST', url: '/documents', headers: { ...auth, ...headers }, payload });
    if (res.statusCode !== 201) throw new Error(`documents fixture: ${fields.category} upload refused: ${res.statusCode} ${res.body}`);
    return (res.json() as { id: string }).id;
  };

  const people: Partial<DocumentsFixture> = {};
  for (const who of PEOPLE) {
    const contact = await makeContact(app.db, { firstName: 'Synthetic', lastName: who.lastName, email: who.email });
    await app.db.query(
      `UPDATE contacts SET soto_status = 'active', is_test = true, test_note = 'Harness fixture: the Documents page with three kinds of row (R49).' WHERE id = $1`,
      [contact.id]
    );

    const opened = await app.inject({
      method: 'POST', url: '/tax-engagements', headers: auth,
      payload: { reason: 'Return opened by hand for the Documents fixture; the letter was signed across the desk', contactId: contact.id, taxYear, returnType: '1040', title: `Harness documents: ${taxYear} return` },
    });
    if (opened.statusCode !== 201) throw new Error(`documents fixture: the tax engagement was refused: ${opened.statusCode} ${opened.body}`);
    const taxEngagementId = (opened.json() as { id: string }).id;

    const markers = {
      signedLetter: `HARNESS-DOCS-SIGNED-ENGAGEMENT-LETTER-${who.key.toUpperCase()}.pdf`,
      returnFile: `HARNESS-DOCS-1040-RETURN-${who.key.toUpperCase()}.pdf`,
      clientUpload: `HARNESS-DOCS-CLIENT-W2-${who.key.toUpperCase()}.pdf`,
    };
    await fileAs({ contactId: contact.id, category: 'signed_authorizations', taxEngagementId, engagementLetterSignedOn: todayChicago() }, markers.signedLetter);
    await fileAs({ contactId: contact.id, category: 'return_deliverable', taxEngagementId, taxYear: String(taxYear) }, markers.returnFile);

    // 'Grant access' through its own route (the invite is link one), then one request for the spare.
    const granted = await tokensFrom(async () => (await app.inject({ method: 'POST', url: '/portal-users', headers: auth, payload: { contactId: contact.id } })).statusCode);
    const spare = await tokensFrom(async () => (await app.inject({ method: 'POST', url: '/portal/auth/magic/request', payload: { email: who.email } })).statusCode);
    const portalMagicTokens = [...granted.tokens, ...spare.tokens];
    const portalMagicLinks = [...granted.links, ...spare.links];
    if (portalMagicTokens.length < 2) throw new Error(`documents fixture: only ${portalMagicTokens.length} sign-in link(s) reached the mailer for ${who.lastName}`);

    people[who.key] = { contactId: contact.id, taxEngagementId, taxYear, portalMagicTokens, portalMagicLinks, markers };
  }
  return { phone: people.phone!, desk: people.desk! };
}
