/*
 * THE 990 VARIANT OF PATH B (Brian, 2026-09-26, R66): an exempt organization's Form 990 on extension,
 * walked at 390 and 1280 (apps/e2e/tests/ops-path-b-990.spec.ts, path N). Ana-Maria's first SAOS
 * returns are three Form 990s due 2026-11-15; this is the shape she will work.
 *
 * WHAT IS HERE AND WHY — the harness builds only what the screens the walk taps do not:
 *
 *   THE ORGANIZATION, twice — one per viewport, because the walk files and completes its return
 *   once. A synthetic contact (flagged is_test) holding a synthetic Illinois nonprofit with an EIN
 *   from the range the issuer never uses (the acknowledgment row the walk uploads matches the
 *   EIN's last four and the folded entity name, the way the real ATX export matches).
 *
 *   THE RETURN AT READY TO FILE, through the doors the API already has: opened by hand with a
 *   reason (no quote stands behind it — BIZ_990 prices the 990 and the 990-EZ, and the range is
 *   read from it), the engagement letter signed across the desk and uploaded, the estimate locked
 *   and the final fee set to the book's own 990 amount (read from the price book in force; never
 *   a literal here), the stages walked to ready_to_file. What the spec then taps is the subject of
 *   the ruling: Record extension (8868 by default), the signed 8879-TE, Mark filed, the ATX
 *   acknowledgment that completes it.
 */
import type { FastifyInstance } from 'fastify';
import { makeContact, multipartBody } from '../../test/helpers.ts';
import { todayChicago } from '../../src/modules/tax/deadlines.ts';

export interface Path990Org {
  contactId: string;
  businessId: string;
  taxEngagementId: string;
  taxYear: number;
  /** The legal name as ATX prints it on the export (upper case, no punctuation): the row the walk uploads. */
  orgName: string;
  /** The EIN's last four; the export's identifier column agrees with it. */
  einLast4: string;
  /** The full synthetic EIN digits, for the export's identifier column (the 90-000xxxx range is never issued). */
  einDigits: string;
  state: string;
}
export interface Path990Fixture {
  phone: Path990Org;
  desk: Path990Org;
  preparer: { id: string; name: string };
  [key: string]: unknown;
}
export interface Path990Deps {
  staffToken: string;
  /** Ana-Maria, the tax_preparer — assigned, and the PTIN holder on the 8879-TE and the filing. */
  preparer: { id: string; name: string };
  taxYear: number;
}

const ORGS = [
  { key: 'phone' as const, lastName: 'Exemptphone', email: 'exempt-phone@example.test', org: 'Synthetic Exempt Org Phone', ein: '90-0004427' },
  { key: 'desk' as const, lastName: 'Exemptdesk', email: 'exempt-desk@example.test', org: 'Synthetic Exempt Org Desk', ein: '90-0004428' },
];
const STATE = 'IL';
const PDF = Buffer.from('%PDF-1.4 synthetic harness document - no real client data\n%%EOF');

export async function buildPath990(app: FastifyInstance, deps: Path990Deps): Promise<Path990Fixture> {
  const headers = { authorization: `Bearer ${deps.staffToken}` };
  const today = todayChicago();
  const call = async (method: 'POST', url: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const r = await app.inject({ method, url, headers, payload });
    if (r.statusCode >= 300) throw new Error(`Path 990: ${method} ${url} answered ${r.statusCode} ${r.body}`);
    return r.json() as Record<string, unknown>;
  };

  // The book's own 990 line: the estimate and the fee are that amount, read, never written here.
  const { rows: priced } = await app.db.query<{ amount_cents: number }>(
    `SELECT pbi.amount_cents
       FROM price_book_items pbi JOIN price_book_versions v ON v.id = pbi.version_id
      WHERE pbi.item_code = 'BIZ_990' AND pbi.is_active AND pbi.amount_cents IS NOT NULL
        AND v.effective_from <= CURRENT_DATE AND (v.effective_to IS NULL OR v.effective_to > CURRENT_DATE)
      LIMIT 1`
  );
  const amount = priced[0]?.amount_cents;
  if (!amount) throw new Error('Path 990 needs BIZ_990 priced in the price book in force');

  const orgs: Partial<Record<'phone' | 'desk', Path990Org>> = {};
  for (const o of ORGS) {
    const contact = await makeContact(app.db, { firstName: 'Synthetic', lastName: o.lastName, email: o.email });
    await app.db.query(
      `UPDATE contacts SET is_test = true, state = $2, test_note = 'Harness fixture: the Form 990 on extension, 8879-TE (Path B, 990 variant).' WHERE id = $1`,
      [contact.id, STATE]
    );
    const biz = await call('POST', `/contacts/${contact.id}/businesses`, {
      name: o.org, ein: o.ein, entityType: 'nonprofit', state: STATE, fiscalYearEndMonth: 12,
    });
    const ret = await call('POST', '/tax-engagements', {
      contactId: contact.id, businessId: biz.id, taxYear: deps.taxYear, returnType: '990', clientType: 'nonprofit',
      preparerId: deps.preparer.id,
      reason: 'Harness fixture: the exempt organization engaged by phone; the return is opened by hand for the 990 walk.',
    });
    const teId = String(ret.id);
    // The engagement letter, signed across the desk: the paper door, the same one the row offers.
    const letter = multipartBody(
      { contactId: contact.id, category: 'signed_authorizations', taxEngagementId: teId, engagementLetterSignedOn: today },
      { field: 'file', filename: `HARNESS-990-LETTER-${o.key}.pdf`, contentType: 'application/pdf', data: PDF }
    );
    const up = await app.inject({ method: 'POST', url: '/documents', headers: { ...headers, ...letter.headers }, payload: letter.payload });
    if (up.statusCode >= 300) throw new Error(`Path 990: the letter upload answered ${up.statusCode} ${up.body}`);
    await call('POST', `/tax-engagements/${teId}/estimate`, { minCents: amount, maxCents: amount });
    await call('POST', `/tax-engagements/${teId}/final-fee`, { finalFeeCents: amount });
    for (const toStage of ['scheduled', 'documents_requested', 'in_preparation', 'internal_review', 'client_review', 'ready_to_file']) {
      await call('POST', `/tax-engagements/${teId}/transition`, { toStage });
    }
    const einDigits = o.ein.replace(/\D/g, '');
    orgs[o.key] = {
      contactId: contact.id, businessId: String(biz.id), taxEngagementId: teId, taxYear: deps.taxYear,
      orgName: o.org.toUpperCase(), einLast4: einDigits.slice(-4), einDigits, state: STATE,
    };
  }
  return { phone: orgs.phone!, desk: orgs.desk!, preparer: deps.preparer };
}
