/*
 * PATH B FIXTURE (Brian, 2026-09-19 evening, BUILD 4): the 1040 on extension with a walk-in wet
 * signature. The harness taps B1 through B15 against what this builds; it builds only what the
 * screens cannot (the staff accounts and the client contact are the walk's starting point), and
 * every step a person taps is left for the spec. Filled in by the Path B track; e2e-boot.ts calls
 * it once and prints its result under `pathB` in E2E_READY.
 *
 * WHAT IS HERE AND WHY:
 *
 *   THE PERSON, twice — one per viewport, distinct names and emails, because the walk mutates
 *   its client once (a quote accepted, a packet signed, a return filed) and runs at 390 and
 *   1280. Synthetic, flagged is_test, with an Illinois address state so the return files
 *   federally AND in Illinois: completion is every jurisdiction (ruling 2026-09-19, item 4), so
 *   the acknowledgment report the walk uploads carries both rows.
 *
 *   B1 IS A DEFECT, NOT A CHOICE. Ops has no create-contact screen: /clients is search only and
 *   no page in apps/internal posts to /contacts. So the contact is inserted here and the step is
 *   annotated how=fixture. Everything from the quote onward is a screen a person taps.
 *
 *   PORTAL ACCESS, THROUGH THE ROUTE. 'Grant access' on the Ops client page is POST
 *   /portal-users, called here with the walker's own token, which emails the sign-in link the
 *   silent mailer keeps. Two links per person: the walk redeems one and the second is the spare
 *   for a lost session. Three per ten minutes per address is the throttle, so two is inside it.
 *
 *   NO EXTENSION FLAG HERE. 'On extension' belongs to the RETURN, and the return does not exist
 *   until the walk's client accepts the quote (acceptance creates it). Marking it here would mean
 *   creating a return by hand that then collides with the accepted quote's engagement on the
 *   one-active-per-line-period index. The spec records it with the Record extension control on
 *   the return row once the return exists (form 4868, the date filed), and the extended deadline
 *   is derived from return type + year — never typed.
 *
 *   NO PRICE LITERALS. The line the walk quotes is read out of the price book in force (the
 *   individual base return that carries a deposit, so B3 has a deposit to pay); the spec taps it
 *   by the name the builder prints.
 */
import type { FastifyInstance } from 'fastify';
import { makeContact } from '../../test/helpers.ts';

/** One synthetic person per viewport: the client the walk phones in as. */
export interface PathBPerson {
  contactId: string;
  ownerEmail: string;
  firstName: string;
  lastName: string;
  /** Synthetic last four, so the acknowledgment report's taxpayer-id column has something to agree with. */
  ssnLast4: string;
  /** The state the 1040 files in — the contact's, for an individual return. */
  state: string;
  /** Portal sign-in tokens, single use: [0] for the walk, [1] the spare. */
  portalMagicTokens: string[];
}

export interface PathBFixture {
  phone: PathBPerson;
  desk: PathBPerson;
  /** The individual 1040 base line out of the price book in force, named as the builder's chip prints it. */
  item: { code: string; name: string };
  /**
   * ONE ADD-ON BESIDE IT, and not for variety. On price book v4 every individual BASE return is
   * fully prepaid — its deposit is capped at the line's own price, so the base alone leaves a
   * final invoice of nothing once the paid deposit is credited (finding #26), and B13/B14 would
   * be issuing and paying zero. A real 1040 carries schedules; the cheapest add-on that carries
   * no deposit of its own is what gives the walk a balance to settle.
   */
  addOn: { code: string; name: string };
  /** The tax preparer the walk names as the PTIN holder on the 8879 and the filing. */
  preparer: { id: string; name: string };
  /** The harness webhook secret, for the payment event Stripe would send. */
  webhookSecret: string;
  [key: string]: unknown;
}

export interface PathBDeps {
  staffToken: string;
  /** The silent mailer's link store. Tokens this fixture mints are removed again, so nothing downstream reads them. */
  magicTokens: string[];
  drainOutbox: () => Promise<void>;
  /** Ana-Maria, the tax_preparer — the paid preparer of record on Path B. */
  preparer: { id: string; name: string };
}

const PEOPLE = [
  { key: 'phone' as const, firstName: 'Synthetic', lastName: 'Pathb-Phone', email: 'pathb-phone@example.test', ssnLast4: '4417' },
  { key: 'desk' as const, firstName: 'Synthetic', lastName: 'Pathb-Desk', email: 'pathb-desk@example.test', ssnLast4: '4418' },
];
/** Synthetic, and the state the acknowledgment report's second row comes from. */
const STATE = 'IL';

export async function buildPathB(app: FastifyInstance, deps: PathBDeps): Promise<PathBFixture | null> {
  const { staffToken, magicTokens, drainOutbox } = deps;

  /*
   * The line the walk quotes: an individual base return, priced, shown on quotes, carrying a
   * price-book deposit — B3 pays that deposit through the portal's own Pay control. Read, never
   * written here; the amount never leaves the price book.
   */
  const { rows: priced } = await app.db.query<{ item_code: string; name_en: string }>(
    `SELECT pbi.item_code, pbi.name_en
       FROM price_book_items pbi JOIN price_book_versions v ON v.id = pbi.version_id
      WHERE pbi.service_line = 'individual_tax' AND pbi.is_active AND pbi.display_on_quote
        AND pbi.amount_cents IS NOT NULL AND COALESCE(pbi.deposit_cents, 0) > 0
        AND v.effective_from <= CURRENT_DATE AND (v.effective_to IS NULL OR v.effective_to > CURRENT_DATE)
      ORDER BY pbi.amount_cents, pbi.item_code LIMIT 1`
  );
  const item = priced[0];
  if (!item) throw new Error('Path B needs an individual-tax base return with a deposit in the price book in force');

  const { rows: addOns } = await app.db.query<{ item_code: string; name_en: string }>(
    `SELECT pbi.item_code, pbi.name_en
       FROM price_book_items pbi JOIN price_book_versions v ON v.id = pbi.version_id
      WHERE pbi.service_line = 'individual_tax' AND pbi.is_active AND pbi.display_on_quote
        AND pbi.amount_cents IS NOT NULL AND pbi.amount_cents > 0 AND COALESCE(pbi.deposit_cents, 0) = 0
        AND NOT pbi.needs_confirmation AND pbi.unit = 'flat'
        AND v.effective_from <= CURRENT_DATE AND (v.effective_to IS NULL OR v.effective_to > CURRENT_DATE)
      ORDER BY pbi.amount_cents, pbi.item_code LIMIT 1`
  );
  const addOn = addOns[0];
  if (!addOn) throw new Error('Path B needs an individual-tax add-on without a deposit in the price book in force');

  /** The links a request left with the mailer, taken back out so E2E_READY's own slice is untouched. */
  const tokensFrom = async (request: () => Promise<number>): Promise<string[]> => {
    const before = magicTokens.length;
    const status = await request();
    if (status >= 300) throw new Error(`Path B: a sign-in link was refused with ${status}`);
    await drainOutbox();
    return magicTokens.splice(before);
  };

  const people: Partial<Record<'phone' | 'desk', PathBPerson>> = {};
  for (const who of PEOPLE) {
    const contact = await makeContact(app.db, { firstName: who.firstName, lastName: who.lastName, email: who.email });
    await app.db.query(
      `UPDATE contacts SET is_test = true, state = $2, ssn_last4 = $3,
              test_note = 'Harness fixture: the 1040 on extension, walk-in wet signature (Path B).'
        WHERE id = $1`,
      [contact.id, STATE, who.ssnLast4]
    );

    // 'Grant access' on the Ops client page, through its own route: it creates the portal user
    // and emails the link. Then one more, so a lost session has a spare inside the throttle.
    const granted = await tokensFrom(async () => {
      const r = await app.inject({
        method: 'POST', url: '/portal-users',
        headers: { authorization: `Bearer ${staffToken}` },
        payload: { contactId: contact.id },
      });
      return r.statusCode;
    });
    const spare = await tokensFrom(async () => {
      const r = await app.inject({ method: 'POST', url: '/portal/auth/magic/request', payload: { email: who.email } });
      return r.statusCode;
    });
    const portalMagicTokens = [...granted, ...spare];
    if (portalMagicTokens.length < 2) {
      throw new Error(`Path B: only ${portalMagicTokens.length} sign-in link(s) reached the mailer for ${who.lastName}`);
    }

    people[who.key] = {
      contactId: contact.id,
      ownerEmail: who.email,
      firstName: who.firstName,
      lastName: who.lastName,
      ssnLast4: who.ssnLast4,
      state: STATE,
      portalMagicTokens,
    };
  }

  return {
    phone: people.phone!,
    desk: people.desk!,
    item: { code: item.item_code, name: item.name_en },
    addOn: { code: addOn.item_code, name: addOn.name_en },
    preparer: deps.preparer,
    webhookSecret: app.config.WEBHOOK_SECRET,
  };
}
