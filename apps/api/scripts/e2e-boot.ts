/*
 * THE HARNESS'S API (decision 3, 2026-09-10). A fresh test database (the same createTestConfig
 * the specs use: migrated, seeded, NODE_ENV=test, the stub Stripe adapter — which decision 4
 * allows here and nowhere else), one synthetic client built THROUGH THE ROUTES, never SQL, into
 * every state the phone walks have failed on, and a staff login minted the way the specs mint
 * theirs. Then the server listens and prints one line the harness reads:
 *
 *   E2E_READY {"port":3101,"contactId":"…","staff":{"email":"…","password":"…","totpSecret":"…"}, …}
 *
 * Synthetic data only. Never run against anything but the developer database server.
 */
import { buildServer } from '../src/server.ts';
import { createTestConfig, makeContact, makeStaff } from '../test/helpers.ts';
import { waiveStripeCheck } from '../src/modules/billing/drift.ts';
import type { Mailer } from '../src/mailer.ts';
import { createQuote, sendQuote, acceptQuote } from '../src/modules/pricing/quotes.ts';
import { createInvoice, markInvoicePaid } from '../src/modules/billing/service.ts';
import { voidInvoice } from '../src/modules/billing/void.ts';
import { handleStripeEvent } from '../src/modules/billing/refunds.ts';
import { mapStripeEvent } from '../src/modules/billing/stripe.ts';
import { createEngagement } from '../src/modules/engagements/service.ts';
import { pauseEngagement } from '../src/modules/engagements/pause.ts';
import { drainOutbox } from '../src/outbox.ts';
import { createTask } from '../src/modules/tasks/service.ts';
import { uploadDocument } from '../src/modules/documents/service.ts';
import { makeMinioClient } from '../src/modules/documents/storage.ts';
import { todayChicago } from '../src/modules/tax/deadlines.ts';
import { defaultTaxYear } from '../src/modules/engagements/period.ts';
import * as OTPAuth from 'otpauth';
import { buildPathB } from './e2e-fixtures/path-b.ts';

const PORT = Number(process.env.E2E_API_PORT ?? 3101);
const TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

const config = await createTestConfig('e2e');
if (!/localhost|127\.0\.0\.1/.test(config.DATABASE_URL)) throw new Error('refusing: the harness database is not local');
/*
 * The mailer sends nothing and REMEMBERS the sign-in link. Page two walks the portal, and the
 * only way in is the magic link the real route emails — so the harness reads it the way the
 * client would, out of the message, rather than minting a session behind the route's back.
 */
const magicTokens: string[] = [];
/*
 * AND THE PROPOSAL LINK (2026-09-19 evening, BUILD 1). The spec now sends the quote from the Ops
 * builder, so the client's acceptance link does not exist at boot — it arrives in the mailer
 * mid-run like any other message. Captured here, the same way and for the same reason as the
 * sign-in link: the harness reads what the client was emailed, not a token out of the database.
 */
const quoteTokens: string[] = [];
const silentMailer: Mailer = {
  transport: 'console',
  async send(msg) {
    const body = `${msg.subject ?? ''} ${msg.text ?? ''} ${msg.html ?? ''}`;
    const found = /[?&]token=([A-Za-z0-9_-]+)/.exec(body);
    if (found) magicTokens.push(found[1]!);
    const quote = /\/quote\/([A-Za-z0-9_-]{20,})/.exec(body);
    if (quote) quoteTokens.push(quote[1]!);
    return { id: 'e2e' };
  },
};
const app = buildServer(config, { mailer: silentMailer });
/*
 * The mailer's own record, readable by the spec while it runs. The proposal is sent by a tap on
 * /pipeline, and the only honest way to the acceptance link from there is the email it produced.
 * Registered before ready(), served on the harness API port, and it exists only in this script —
 * nothing in apps/api/src knows about it, and the boot has already refused a non-local database.
 */
app.get('/harness/mail-links', async () => ({ quoteTokens, magicTokens }));
await app.ready();

// The staff member who walks the page.
const staff = await makeStaff(app.db, config, {
  email: 'walker@example.test', name: 'Synthetic Walker', role: 'ceo',
  password: 'walker-synthetic-2026', totpSecret: TOTP_SECRET,
});
const actor = { id: staff.id, email: staff.email, fullName: staff.fullName, roleKey: 'ceo' as const, permissions: ['*'], sessionId: 'e2e' };

// The client: a test client, so the page carries the TEST badge too.
const contact = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Walkclient', email: 'walkclient@example.test' });
await app.db.query(`UPDATE contacts SET soto_status = 'active', is_test = true, test_note = 'Harness fixture: every invoice state the walks have failed on.' WHERE id = $1`, [contact.id]);

// Every amount on the page comes from the price book — the fixture too (CLAUDE.md: no literal
// prices in application code, and the guard reads this script).
interface PricedItem { item_code: string; amount_cents: number }
async function activeItems(where: string): Promise<PricedItem[]> {
  const { rows } = await app.db.query<PricedItem>(
    `SELECT pbi.item_code, pbi.amount_cents FROM price_book_items pbi JOIN price_book_versions v ON v.id = pbi.version_id
      WHERE ${where} AND pbi.is_active AND pbi.amount_cents > 0
        AND v.effective_from <= CURRENT_DATE AND (v.effective_to IS NULL OR v.effective_to > CURRENT_DATE)
      ORDER BY pbi.amount_cents, pbi.item_code`);
  return rows;
}
const [small, larger] = await activeItems('COALESCE(pbi.deposit_cents, 0) = 0');
if (!small || !larger || small.amount_cents === larger.amount_cents) throw new Error('the price book needs two priced items without a deposit for the fixture');

async function depositItem(): Promise<string> {
  const { rows } = await app.db.query<{ item_code: string }>(
    `SELECT pbi.item_code FROM price_book_items pbi JOIN price_book_versions v ON v.id = pbi.version_id
      WHERE pbi.deposit_cents > 0 AND pbi.is_active AND pbi.display_on_quote AND pbi.amount_cents IS NOT NULL
        AND v.effective_from <= CURRENT_DATE AND (v.effective_to IS NULL OR v.effective_to > CURRENT_DATE)
      ORDER BY pbi.item_code LIMIT 1`);
  return rows[0]!.item_code;
}

// 1. A quote accepted: the deposit invoice is issued (sent) — then PAID through the stub's
//    payment event, so the engagement holds a paid deposit (the withdraw modal's choice case).
const WALL = {
  ssnLast4: '7391',
  taxDoc: 'HARNESS-W2-2025-TAXDOC.pdf',
  irsNotice: 'HARNESS-CP2000-NOTICE.pdf',
  bankDoc: 'HARNESS-BANK-STATEMENT.pdf',
  entityDoc: 'HARNESS-ARTICLES-OF-ORGANIZATION.pdf',
  interview: 'HARNESS-INTERVIEW-ANSWER-MARKER',
  complexity: 'HARNESS-COMPLEXITY-MARKER',
  transcript: 'HARNESS-CPA-TRANSCRIPT-MARKER',
  summary: 'HARNESS-CPA-SUMMARY-MARKER',
};
// A business line names its business (2026-09-12): the harness client has one, and the quote says so.
const harnessBiz = await app.db.query<{ id: string }>(`INSERT INTO businesses (name, entity_type, state) VALUES ('Harness Books LLC', 'llc', 'IL') RETURNING id`);
await app.db.query(`INSERT INTO business_members (business_id, contact_id, member_role, is_primary) VALUES ($1, $2, 'owner', true)`, [harnessBiz.rows[0]!.id, contact.id]);
const q1 = await createQuote(app, { contactId: contact.id, businessId: harnessBiz.rows[0]!.id, lines: [{ itemCode: await depositItem() }], interviewAnswers: { dependents: 2, note: WALL.interview } }, actor);
const s1 = await sendQuote(app, q1.id, actor);
const acc1 = await acceptQuote(app, s1.url.split('/').pop()!, {});
await drainOutbox(app); // the deposit email leaves; the send log has a row
await markInvoicePaid(app, acc1.depositInvoiceId!, { paymentIntentId: 'pi_e2e_paid_deposit' });

// 2. A second engagement (so the withdraw modal offers "Move to …") with its deposit invoice
//    VOIDED through the void route: the void line the phone walk failed on.
const e2 = await createEngagement(app, actor, { contactId: contact.id, serviceLine: 'bookkeeping', title: 'Books, monthly', status: 'active' }, {});
const toVoid = await createInvoice(app, { type: 'staff', id: staff.id, label: staff.fullName }, { contactId: contact.id, engagementId: e2.id, lines: [{ description: 'Books, monthly — first month', unitCents: small.amount_cents }], send: false, issued: true });
await voidInvoice(app, toVoid.id, { reason: 'Harness: superseded by the deposit invoice' }, actor);
await drainOutbox(app); // the cancellation notice through its gate

// 3. A paid invoice refunded in full, and one refunded in part — through the webhook handler.
const mkPaid = async (description: string, cents: number, pi: string) => {
  // cents is a price-book amount, passed through
  const inv = await createInvoice(app, { type: 'staff', id: staff.id, label: staff.fullName }, { contactId: contact.id, engagementId: e2.id, lines: [{ description, unitCents: cents }], send: false, issued: true });
  await markInvoicePaid(app, inv.id, { paymentIntentId: pi });
  return inv.id;
};
const full = small.amount_cents;
await mkPaid('Books, monthly — refunded in full', full, 'pi_e2e_refunded');
await handleStripeEvent(app, mapStripeEvent({ id: 'evt_e2e_refund_full', type: 'charge.refunded', data: { object: { id: 'ch_e2e_refunded', payment_intent: 'pi_e2e_refunded', amount: full, amount_refunded: full, refunded: true, refunds: { data: [{ id: 're_e2e_full', amount: full, created: Math.floor(Date.now() / 1000) }] } } } }));
const paid = larger.amount_cents;
const part = Math.floor(paid / 4);
await mkPaid('Books, monthly — refunded in part', paid, 'pi_e2e_partial');
await handleStripeEvent(app, mapStripeEvent({ id: 'evt_e2e_refund_part', type: 'charge.refunded', data: { object: { id: 'ch_e2e_partial', payment_intent: 'pi_e2e_partial', amount: paid, amount_refunded: part, refunded: false, refunds: { data: [{ id: 're_e2e_part', amount: part, created: Math.floor(Date.now() / 1000) }] } } } }));
await drainOutbox(app);

// 4. An open (sent) invoice for the reminder and pay-link controls.

await createInvoice(app, { type: 'staff', id: staff.id, label: staff.fullName }, { contactId: contact.id, engagementId: e2.id, lines: [{ description: 'Books, monthly — open', unitCents: larger.amount_cents }], send: false, issued: true });

// 5. The books engagement goes ON HOLD through the pause route: a two-word status, so a badge
//    that falls back to the raw enum (on_hold) is a visible failure, not a lowercase word.
await pauseEngagement(app, e2.id, { reason: 'Harness: client travelling' }, { type: 'staff', id: staff.id, label: staff.fullName });

/*
 * PAGE THREE needs a queue with something in it: one overdue, one due today, one with no due
 * date, one far off. Those are the shapes the phone card has to render side by side. Through
 * createTask, the same service every route uses.
 */
const taskSeed = [
  { title: 'Harness: overdue, high priority', dueDate: '2026-09-01', priority: 2 },
  { title: 'Harness: due today', dueDate: todayChicago(), priority: 1 },
  { title: 'Harness: no due date', priority: 0 },
  { title: 'Harness: someday', dueDate: '2026-12-31', priority: 0 },
];
for (const t of taskSeed) {
  await createTask(app, {
    title: t.title,
    contactId: contact.id,
    assignedStaffId: staff.id,
    priority: t.priority,
    ...(t.dueDate ? { dueDate: t.dueDate } : {}),
    source: 'manual',
  });
}

/*
 * PAGE FOUR (2026-09-12): the §7216 wall, read as Laura (va_entity) and Jaqueline (ed_coo). The
 * client carries each of the four walled things with a unique synthetic marker: the SSN last-4,
 * documents in walled and allowed categories, interview answers on the quote above and complexity
 * inputs on a tax engagement, and a CPA session with a transcript and a summary. The two personas
 * sign in the way the walker does.
 */
const laura = await makeStaff(app.db, config, { email: 'laura-walker@example.test', name: 'Synthetic Laura', role: 'va_entity', password: 'laura-synthetic-2026', totpSecret: TOTP_SECRET });
const jaqueline = await makeStaff(app.db, config, { email: 'jaqueline-walker@example.test', name: 'Synthetic Jaqueline', role: 'ed_coo', password: 'jaqueline-synthetic-2026', totpSecret: TOTP_SECRET });
// The bookkeeper (Marian's role): the role proof for Add a business moves here (R4, 2026-09-19 evening).
const bookkeeper = await makeStaff(app.db, config, { email: 'bookkeeper-walker@example.test', name: 'Synthetic Bookkeeper', role: 'bookkeeper', password: 'bookkeeper-synthetic-2026', totpSecret: TOTP_SECRET });
await app.db.query(`UPDATE contacts SET ssn_last4 = $2 WHERE id = $1`, [contact.id, WALL.ssnLast4]);
const minio = makeMinioClient(config);
const PDF = Buffer.from('%PDF-1.4 synthetic harness document — no real client data\n%%EOF');
const uploadAs = (category: string, filename: string) => uploadDocument(app, minio, { type: 'staff', id: staff.id, label: staff.fullName }, { contactId: contact.id, category, filename, mimeType: 'application/pdf', buffer: PDF });
const taxDocument = await uploadAs('tax_documents', WALL.taxDoc);
await uploadAs('irs_notices', WALL.irsNotice);
const bankDocument = await uploadAs('business_records', WALL.bankDoc);
const entityDocument = await uploadAs('entity_filings', WALL.entityDoc);
const cpaMeeting = await app.db.query<{ id: string }>(
  `INSERT INTO meetings (contact_id, staff_id, type, source, status, title, started_at)
   VALUES ($1, $2, 'in_person', 'manual', 'ready', 'Harness CPA session', now() - interval '1 hour') RETURNING id`,
  [contact.id, staff.id]
);
const cpaMeetingId = cpaMeeting.rows[0]!.id;
await app.db.query(`INSERT INTO transcripts (meeting_id, engine, content) VALUES ($1, 'test', $2)`, [cpaMeetingId, `Verbatim. ${WALL.transcript}`]);
await app.db.query(
  `INSERT INTO meeting_summaries (meeting_id, summary, client_recap_status, recap_body_en, recap_body_es) VALUES ($1, $2, 'drafted', $3, $3)`,
  [cpaMeetingId, WALL.summary, `Recap. ${WALL.summary}`]
);

/*
 * PAGE TWO'S WAY IN. 'Grant access' on the Ops client page is POST /portal-users; it creates
 * the portal user and emails the sign-in link. Called through the route with the walker's own
 * token, so the fixture uses the control a person uses.
 */
// The walker signs in the way the spec does — password plus TOTP — because the route needs a
// real session token and makeStaff only makes the account.
const totp = new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(TOTP_SECRET) }).generate();
const loggedIn = await app.inject({
  method: 'POST', url: '/auth/login',
  payload: { email: staff.email, password: 'walker-synthetic-2026', totp },
});
if (loggedIn.statusCode !== 200) throw new Error(`the walker could not sign in: ${loggedIn.statusCode} ${loggedIn.body}`);
const staffToken = loggedIn.json().token as string;

const taxEngagement = await app.inject({
  method: 'POST', url: '/tax-engagements',
  headers: { authorization: `Bearer ${staffToken}` },
  payload: { reason: 'Return opened by hand for the fixture; the client engaged by phone and the quote follows', contactId: contact.id, taxYear: 2024, returnType: '1040', title: 'Harness wall: 2024 return' },
});
if (taxEngagement.statusCode !== 201) throw new Error(`the tax engagement was refused: ${taxEngagement.statusCode} ${taxEngagement.body}`);
const taxEngagementId = (taxEngagement.json() as { id: string }).id;
await app.db.query(`UPDATE tax_engagements SET complexity_inputs = $2::jsonb WHERE id = $1`, [taxEngagementId, JSON.stringify({ states: 1, note: WALL.complexity })]);

const granted = await app.inject({
  method: 'POST', url: '/portal-users',
  headers: { authorization: `Bearer ${staffToken}` },
  payload: { contactId: contact.id },
});
if (granted.statusCode >= 300) throw new Error(`portal access was refused: ${granted.statusCode} ${granted.body}`);
await drainOutbox(app);

/*
 * PAGE FIVE (2026-09-12) BECAME A WALK (2026-09-19 evening, BUILD 1). The fixture used to build the
 * S corporation's whole front half through the routes: the quote, the $0 deposit override, the
 * send, the acceptance, the packet, the onboarding questionnaire, the uploaded document, the stage
 * walk and the delivery. Every one of those is a screen a person taps, so every one of them is now
 * tapped by ops-scorp-dry-run.spec.ts (A2, A3, A4) and portal-returns.spec.ts (A5).
 *
 * WHAT STAYS HERE, AND WHY:
 *
 *   the owner contact (is_test, active)  the walk's starting point; a client exists before Brian
 *                                       opens the builder, and A1 — adding a business with its
 *                                       EIN — is already tapped by ops-add-business.spec.ts.
 *   the business with its EIN            the entity the business-tax quote is written against.
 *                                       A1 is cleared on the harness client; no walk step covers
 *                                       a second entity, so this one is set up, not walked.
 *   portal access + three sign-in links  through POST /portal-users ('Grant access'), then the
 *                                       public request route. The throttle is three links per ten
 *                                       minutes per address (portal-auth/service.ts) and a link is
 *                                       single use: the invite plus two requests is exactly three,
 *                                       one each for the dry run's portal turn (A3), My Returns
 *                                       (A5) and the checkout walk. They must be minted at boot
 *                                       for that budget to hold.
 *
 * WHAT IS NOT HERE: the engagement letter stamp and the preparer assignment. Both live on the
 * tax_engagements row, which does not exist until the client accepts the quote (a tap). Since
 * 2026-09-20 the client's packet signature in the portal stamps the letter on every return of theirs,
 * and the sole active tax_preparer is assigned at creation, with an Assign preparer control on the
 * row; the spec taps the signature and the control, nothing goes through a bare route.
 */
const anamaria = await makeStaff(app.db, config, { email: 'anamaria-walker@example.test', name: 'Synthetic Ana-Maria', role: 'tax_preparer', password: 'anamaria-synthetic-2026', totpSecret: TOTP_SECRET });
/* ONE S CORPORATION PER VIEWPORT (2026-09-19, BUILD 3): the dry run taps its way from the quote to the paid
 * invoice at 390 and again at 1280, and each flow mutates its return once, so the fixture is built twice. */
async function buildScorp(who: { email: string; lastName: string }, entity: { name: string; ein: string }) {
  const scorpOwner = await makeContact(app.db, { firstName: 'Synthetic', lastName: who.lastName, email: who.email });
  await app.db.query(`UPDATE contacts SET soto_status = 'active', is_test = true, test_note = 'Harness fixture: the S corporation rehearsal.' WHERE id = $1`, [scorpOwner.id]);
  const scorpBiz = await app.inject({
    method: 'POST', url: `/contacts/${scorpOwner.id}/businesses`, headers: { authorization: `Bearer ${staffToken}` },
    payload: { name: entity.name, ein: entity.ein, entityType: 's_corp', state: 'IL' },
  });
  if (scorpBiz.statusCode !== 201) throw new Error(`the S corp business was refused: ${scorpBiz.statusCode} ${scorpBiz.body}`);
  const scorpBusinessId = (scorpBiz.json() as { id: string }).id;

  /*
   * THE WAY IN, three times over. 'Grant access' creates the portal account and emails the invite;
   * two more public requests fill the throttle's budget. Each link is single use, so the tokens are
   * handed out one per spec: [0] the dry run's A3, [1] My Returns (A5), [2] the checkout walk.
   */
  const firstToken = magicTokens.length;
  const granted = await app.inject({
    method: 'POST', url: '/portal-users', headers: { authorization: `Bearer ${staffToken}` },
    payload: { contactId: scorpOwner.id },
  });
  if (granted.statusCode >= 300) throw new Error(`portal access for the S corp owner was refused: ${granted.statusCode} ${granted.body}`);
  await drainOutbox(app);
  for (let i = 0; i < 2; i++) {
    const asked = await app.inject({ method: 'POST', url: '/portal/auth/magic/request', payload: { email: scorpOwner.email } });
    if (asked.statusCode !== 200) throw new Error(`the S corp owner's sign-in link was refused: ${asked.statusCode} ${asked.body}`);
    await drainOutbox(app);
  }
  const scorpMagicTokens = magicTokens.splice(firstToken);
  if (scorpMagicTokens.length < 3) throw new Error(`only ${scorpMagicTokens.length} sign-in link(s) reached the mailer for ${who.email} — the walk needs three`);
  return { scorpOwner, scorpBusinessId, scorpMagicTokens };
}
const S = await buildScorp({ email: 'scorpowner@example.test', lastName: 'Scorpowner' }, { name: 'Harness S Corp, LLC', ein: '55-5555555' });
const D = await buildScorp({ email: 'scorpowner-desk@example.test', lastName: 'Scorpdesk' }, { name: 'Harness Desk Corp, LLC', ein: '55-5555556' });
// Brian arms these himself on the box; the harness arms them so the sends are real here.
await app.db.query(`UPDATE automations SET enabled = true WHERE key IN ('efile_acknowledgment', 'payment_receipt')`);
// The year the quote builder will offer for a return quoted today — the one rule, read, not restated.
const scorpTaxYear = defaultTaxYear(todayChicago());

/*
 * THE REFUSED AMEND AT 390px (Brian, 2026-09-19, defect 2): the harness client's paid deposit
 * gets a drift finding and a waiver, so the client page offers "Amend reason" and the harness can
 * type a chat artifact into it and read the refusal beside the field.
 */
await createTask(app, { title: 'Harness: Stripe cannot see this payment', contactId: contact.id, priority: 2, source: 'automation', sourceType: 'stripe_drift', sourceId: acc1.depositInvoiceId! });
await waiveStripeCheck(app, acc1.depositInvoiceId!, 'Paid under the harness stub; the live key cannot see that payment', { id: staff.id, fullName: staff.fullName });


/*
 * A MAGIC LINK IS SINGLE USE, and the harness runs page two once per viewport. So each project
 * gets its own, requested through the public route a client uses. Two more, plus the one 'Grant
 * access' already sent, sits under the three-per-ten-minutes throttle in portal-auth/service.ts.
 */
for (let i = 0; i < 2; i++) {
  const asked = await app.inject({ method: 'POST', url: '/portal/auth/magic/request', payload: { email: contact.email } });
  if (asked.statusCode !== 200) throw new Error(`a sign-in link was refused: ${asked.statusCode} ${asked.body}`);
  await drainOutbox(app);
}
if (magicTokens.length < 2) throw new Error(`only ${magicTokens.length} sign-in link(s) reached the mailer — page two cannot log in twice`);

// Path B (the 1040 on extension) is built by its own module; null until that track lands.
const pathB = await buildPathB(app, { staffToken, magicTokens, drainOutbox: () => drainOutbox(app), preparer: { id: anamaria.id, name: anamaria.fullName } });
await app.listen({ port: PORT, host: '127.0.0.1' });
// The harness API runs no scheduler (that is index.ts's job). The outbox fast lane is what a person
// waits on after a release, so the harness drains it every two seconds, the way the box does every minute.
const harnessSweep = setInterval(() => { drainOutbox(app).catch(() => undefined); }, 2000);
harnessSweep.unref();
/*
 * The handles the walk needs, and no state it now taps for itself. `itemCode` is the price-book
 * line the builder picks (never an amount — the guard reads this script and the book is the only
 * source of a price); `markers.document` and `markers.returnFile` are the file names the spec
 * uploads, declared here so both the walk and the reads agree on what to look for. The tax year
 * comes from the catalog's default at build time, which is what the builder will offer.
 */
const scorpFixture = (x: Awaited<ReturnType<typeof buildScorp>>, entityName: string, einLast4: string, business: string) => ({
  contactId: x.scorpOwner.id, businessId: x.scorpBusinessId,
  itemCode: 'BIZ_1120S',
  markers: { business, document: 'HARNESS-SCORP-BANK-STATEMENT.pdf', returnFile: 'HARNESS-SCORP-1120S-RETURN.pdf' },
  entityName, einLast4, taxYear: scorpTaxYear,
  preparer: { id: anamaria.id, name: anamaria.fullName },
  ownerEmail: x.scorpOwner.email,
  /** Single use, one per spec: [0] the dry run's portal turn (A3), [1] My Returns (A5), [2] the checkout walk. */
  portalMagicTokens: x.scorpMagicTokens,
  invoiceItemCode: small.item_code,
  webhookSecret: config.WEBHOOK_SECRET,
  apiPort: PORT,
});
console.log('E2E_READY ' + JSON.stringify({
  port: PORT,
  contactId: contact.id,
  engagementWithDeposit: acc1.engagementId,
  staff: { email: staff.email, password: 'walker-synthetic-2026', totpSecret: TOTP_SECRET },
  portalMagicTokens: magicTokens.slice(-2),
  scorp: scorpFixture(S, 'Harness S Corp, LLC', '5555', 'Harness S Corp'),
  scorpDesk: scorpFixture(D, 'Harness Desk Corp, LLC', '5556', 'Harness Desk Corp'),
  amend: { invoiceId: acc1.depositInvoiceId },
  pathB,
  wall: {
    laura: { email: laura.email, password: 'laura-synthetic-2026', totpSecret: TOTP_SECRET },
    jaqueline: { email: jaqueline.email, password: 'jaqueline-synthetic-2026', totpSecret: TOTP_SECRET },
    bookkeeper: { email: bookkeeper.email, password: 'bookkeeper-synthetic-2026', totpSecret: TOTP_SECRET },
    anamaria: { email: anamaria.email, password: 'anamaria-synthetic-2026', totpSecret: TOTP_SECRET },
    quoteId: q1.id, taxEngagementId, cpaMeetingId,
    taxDocumentId: taxDocument.id, entityDocumentId: entityDocument.id, bankDocumentId: bankDocument.id,
    markers: WALL,
  },
}));
// Stay up until the harness kills us.
process.on('SIGTERM', () => { void app.close().then(() => process.exit(0)); });
process.on('SIGINT', () => { void app.close().then(() => process.exit(0)); });
