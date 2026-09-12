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
import * as OTPAuth from 'otpauth';

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
const silentMailer: Mailer = {
  transport: 'console',
  async send(msg) {
    const body = `${msg.subject ?? ''} ${msg.text ?? ''} ${msg.html ?? ''}`;
    const found = /[?&]token=([A-Za-z0-9_-]+)/.exec(body);
    if (found) magicTokens.push(found[1]!);
    return { id: 'e2e' };
  },
};
const app = buildServer(config, { mailer: silentMailer });
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
const q1 = await createQuote(app, { contactId: contact.id, lines: [{ itemCode: await depositItem() }], interviewAnswers: { dependents: 2, note: WALL.interview } }, actor);
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
  payload: { contactId: contact.id, taxYear: 2024, returnType: '1040', title: 'Harness wall: 2024 return' },
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

await app.listen({ port: PORT, host: '127.0.0.1' });
console.log('E2E_READY ' + JSON.stringify({
  port: PORT,
  contactId: contact.id,
  engagementWithDeposit: acc1.engagementId,
  staff: { email: staff.email, password: 'walker-synthetic-2026', totpSecret: TOTP_SECRET },
  portalMagicTokens: magicTokens.slice(-2),
  wall: {
    laura: { email: laura.email, password: 'laura-synthetic-2026', totpSecret: TOTP_SECRET },
    jaqueline: { email: jaqueline.email, password: 'jaqueline-synthetic-2026', totpSecret: TOTP_SECRET },
    quoteId: q1.id, taxEngagementId, cpaMeetingId,
    taxDocumentId: taxDocument.id, entityDocumentId: entityDocument.id, bankDocumentId: bankDocument.id,
    markers: WALL,
  },
}));
// Stay up until the harness kills us.
process.on('SIGTERM', () => { void app.close().then(() => process.exit(0)); });
process.on('SIGINT', () => { void app.close().then(() => process.exit(0)); });
