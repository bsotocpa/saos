/*
 * PATH B, THE TWO-YEAR VARIANT (Brian, 2026-09-29, R89) — the fixture for path Y.
 *
 * One synthetic person per viewport, with portal access granted through POST /portal-users (the
 * Grant access door), so the walk can build the quote on /pipeline for the current year and three
 * back, accept it in the portal, and read what acceptance opened. Nothing else is built here: the
 * quote, the acceptance and everything after are taps. The lines the walk adds are the ones path B
 * reads out of the book in force (the base return with a deposit, and its schedule), never typed.
 */
import type { FastifyInstance } from 'fastify';
import { defaultTaxYear } from '../../src/modules/engagements/period.ts';
import { todayChicago } from '../../src/modules/tax/deadlines.ts';

export interface TwoYearPerson { contactId: string; fullName: string; lastName: string; portalMagicLinks: string[] }
export interface TwoYearFixture { phone: TwoYearPerson; desk: TwoYearPerson; newYear: number; oldYear: number }

export async function buildTwoYearFixture(
  app: FastifyInstance,
  deps: { staffToken: string; magicTokens: string[]; magicLinks: string[]; drainOutbox: () => Promise<unknown> }
): Promise<TwoYearFixture> {
  const auth = { authorization: `Bearer ${deps.staffToken}` };
  const post = async <T>(url: string, payload: unknown): Promise<T> => {
    const r = await app.inject({ method: 'POST', url, headers: auth, payload });
    if (r.statusCode >= 300) throw new Error(`two-year fixture: POST ${url} answered ${r.statusCode} ${r.body}`);
    return r.json() as T;
  };
  const newYear = defaultTaxYear(todayChicago());
  const out: Partial<TwoYearFixture> = { newYear, oldYear: newYear - 3 };
  for (const key of ['phone', 'desk'] as const) {
    const lastName = `Twoyear${key === 'phone' ? 'Phone' : 'Desk'}`;
    const c = await post<{ id: string }>('/contacts', { firstName: 'Synthetic', lastName, email: `${lastName.toLowerCase()}@example.test` });
    await app.db.query(
      `UPDATE contacts SET soto_status = 'active', is_test = true,
              test_note = 'Harness fixture: path B, the two-year variant (R89): one engagement, one return per year.'
        WHERE id = $1`,
      [c.id]
    );
    const before = deps.magicLinks.length;
    await post('/portal-users', { contactId: c.id });
    await deps.drainOutbox();
    const links = deps.magicLinks.splice(before);
    deps.magicTokens.splice(before);
    if (links.length === 0) throw new Error('two-year fixture: the portal invite reached no mailer');
    out[key] = { contactId: c.id, fullName: `Synthetic ${lastName}`, lastName, portalMagicLinks: links };
  }
  return out as TwoYearFixture;
}
