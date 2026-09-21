/*
 * THE 1120S DRY RUN (Brian, 2026-09-19): the return was filed in ATX on time, outside SAOS. From
 * the first tap to the last the harness does what Brian will do live, through the screens a person
 * taps (ruling 2026-09-19, BUILD 3: no API-driven step; BUILD 1, evening: A2, A3 and A4 come out of
 * the fixture too), at 390 and 1280:
 *
 *   2. the business-tax quote built on /pipeline against the S corp's own entity, its deposit
 *      WAIVED with a standalone reason typed in its panel, and sent;
 *   3. the client's turn, on the link the proposal emailed them: accept, then — signed in with the
 *      sign-in link they were emailed — sign the agreement carrying Schedule B (that signature is
 *      what stamps the engagement letter on the return), answer the business onboarding
 *      questionnaire, and upload a document;
 *   4. the preparer named and the extension recorded from the Returns card, the estimate locked and
 *      the stages walked from the same row, then the return delivered to the portal on
 *      /upload-return;
 *   6. the signed 8879-CORP scan from the return's row on the client page, with its real signed
 *      date (before the SAOS record existed) and Ana-Maria as the PTIN holder: a future date is
 *      refused beside the date control, a past one authorizes;
 *   7. the final fee from the same row: outside the quoted range it is refused in the modal until a
 *      reason is given; then Ready to file, then Mark filed with the PTIN holder, which issues the
 *      final-fee invoice through the money door;
 *   8. the ATX acknowledgment report uploaded on the E-file acks screen, reviewed and released;
 *   9. both rows read Sent; two acceptance emails left, and the return is completed only once the
 *      federal and the Illinois rows are both accepted;
 *  10. the final-fee invoice: the client taps Pay in the portal and the harness asserts the Checkout
 *      URL that tap navigated to, without ever loading the external host; the money itself moves on
 *      the event Stripe posts, which is an API call and is reported as such;
 *  11. the receipt, the money line, the completed engagement with its open balance gone.
 *
 * EVERY STEP IS NOW A TAP (2026-09-20 rulings 10, 11 and 12). The one API row this walk used to
 * carry is gone:
 *
 *   R10  the engagement letter on the RETURN. The client signing the packet in the portal stamps
 *        every return of that contact, so pipeline gate 1 is closed by the client's own tap and the
 *        old POST /tax-engagements/:id/signatures/wet answers 410. A3 reads the stamp back off the
 *        return instead of writing it, and the paper lane's door ("Upload the signed engagement
 *        letter") is asserted GONE from the row — this client signed in the portal.
 *   R11  "Assign preparer" on the row: Ana-Maria is named explicitly, even though she is the
 *        fixture's only active tax preparer and therefore already the default.
 *   R12  "Record extension" on the row: Form 7004 on the 1120S, with the day it went in; the
 *        extended deadline is derived by the route, never typed, and the badge is read back.
 *
 * Each step pushes a walk-step annotation that scripts/walk-evidence.mjs reads into the report.
 * Each viewport taps its own S corporation fixture (scorp for the phone, scorpDesk for the desk),
 * and then reads the finished state on the client page.
 */
import { expect, test, type Page } from '@playwright/test';
import * as OTPAuth from 'otpauth';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..');
interface Persona { email: string; password: string; totpSecret: string }
interface Scorp {
  contactId: string; businessId: string; itemCode: string;
  markers: { business: string; document: string; returnFile: string };
  entityName: string; einLast4: string; taxYear: number; preparer: { id: string; name: string };
  ownerEmail: string; portalMagicTokens: string[]; portalMagicLinks: string[];
  webhookSecret: string; apiPort: number;
}
const fixtures = JSON.parse(readFileSync(resolve(here, '..', '.artifacts', 'fixtures.json'), 'utf8')) as {
  staff: Persona;
  wall: { jaqueline: Persona };
  portalPort?: number;
  scorp: Scorp; scorpDesk: Scorp;
};
/** One S corporation per viewport: each project taps its own return from the quote to the paid invoice. */
const scorpFor = (project: string): Scorp => (project === 'desk' ? fixtures.scorpDesk : fixtures.scorp);
const PORTAL = `http://localhost:${fixtures.portalPort ?? 3106}`;
const API = `http://127.0.0.1:${fixtures.scorp.apiPort ?? 3101}`;
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
const ROLES = 'tax_preparer, ceo (engagements.tax.manage)';
const CLIENT_ROLE = 'client (the emailed proposal link, then the emailed sign-in link)';

async function signIn(page: Page, who: Persona): Promise<void> {
  const code = new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(who.totpSecret) }).generate();
  await page.goto('/login');
  const status = await page.evaluate(async ({ email, password, totp }) => {
    const r = await fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password, totp }) });
    sessionStorage.setItem('saos_staff_authed', '1');
    return r.status;
  }, { email: who.email, password: who.password, totp: code });
  expect(status, `${who.email} signs in`).toBe(200);
}
/**
 * The client's own way in: the single-use link the portal emailed them, FOLLOWED (2026-09-20) —
 * the address bar gets the href as it stood in the message, and the link is spent by the one
 * button on that page, never by the load.
 */
async function signInPortal(page: Page, href: string): Promise<void> {
  await page.goto(href);
  await page.getByTestId('verify-press').click();
  await page.waitForURL((u) => new URL(u).pathname === '/');
}
/** A read of the API from the signed-in session, for assertions on state the screen does not print. */
async function read(page: Page, path: string): Promise<Record<string, unknown>> {
  return page.evaluate(async (p) => (await fetch(`/api${p}`)).json().catch(() => ({})), path);
}
/**
 * THE PROPOSAL LINK, OUT OF THE EMAIL (BUILD 1). The send is a tap on /pipeline, so the client's
 * acceptance link is not in fixtures.json — it is in the message that tap produced. e2e-boot's
 * mailer keeps every link it has seen and serves them on the harness port; the spec takes the ones
 * that arrived after it pressed Send, which is the client's copy and nothing else.
 */
async function quoteLinksSoFar(): Promise<string[]> {
  const r = await fetch(`${API}/harness/mail-links`);
  return ((await r.json()) as { quoteLinks: string[] }).quoteLinks;
}
function keepScreenshot(name: string, passed: boolean, file: string): string {
  const dir = passed ? resolve(here, '..', '.artifacts', today) : resolve(root, 'tasks', 'walks', today);
  mkdirSync(dir, { recursive: true });
  const target = resolve(dir, `${name}.png`);
  if (existsSync(file)) copyFileSync(file, target);
  return target;
}
const plusDays = (n: number): string => {
  const d = new Date(); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const money = (cents: number): string => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
/**
 * A calendar day in the words Ops prints it — the same Intl call apps/internal/lib/dates.ts makes,
 * written out here so a change to the formatter cannot agree with itself.
 */
const dayText = (iso: string): string =>
  new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(`${iso.slice(0, 10)}T00:00:00Z`));

test.describe('The 1120S dry run', () => {
  test('quoted, accepted, signed, delivered, signed 8879-CORP, final fee, filed, acknowledged, paid, completed', async ({ page }, testInfo) => {
    const viewport = testInfo.project.name;
    const scorp = scorpFor(viewport);
    test.setTimeout(900_000); // eleven walk steps across two origins, plus a wait on the outbox sweep
    const shot = testInfo.outputPath(`scorp-dry-run-acks-${viewport}.png`);
    const steps: string[] = [];
    let passed = false;
    try {
      const clientPage = `/clients/${scorp.contactId}`;
      const dialog = page.locator('[role=dialog]');

      // ── 2. THE QUOTE, on /pipeline: the business-tax line against the S corp's entity, the
      //    deposit waived with a reason typed in its own panel, then sent to the client.
      await signIn(page, fixtures.staff);

      // ── 1b. EDIT AFTER CREATE (2026-09-20): the fixture entered the S corporation with its EIN and
      //    nothing else; the formation date and the industry are filled in through the row's Edit door.
      await page.goto(clientPage);
      const bizRow = page.locator('section.card', { has: page.getByRole('heading', { name: 'Businesses' }) }).locator('div.lead-card', { hasText: scorp.entityName }).first();
      await expect(bizRow, 'the S corporation is on the card').toContainText('EIN on file');
      await bizRow.getByRole('button', { name: 'Edit' }).click();
      const editBiz = page.locator('#edit-business-form');
      await expect(editBiz).toBeVisible();
      await editBiz.getByLabel(/Formation date/).fill('2018-03-09');
      await editBiz.getByLabel(/Industry/).fill('professional_services');
      await page.getByRole('button', { name: 'Save business' }).click();
      await expect(page.getByText('Business saved.')).toBeVisible();
      await expect(bizRow, 'the formation date is on the card').toContainText('formed Mar 9, 2018');
      await expect(bizRow, 'and the industry').toContainText('professional_services');
      testInfo.annotations.push({ type: 'edit-door', description: `business|/clients/:id Businesses card, button "Edit" on the row, form#edit-business-form, button "Save business"|ceo (contacts.write); va_entity (businesses.write)|tap` });

      const tokensBefore = (await quoteLinksSoFar()).length;
      await page.goto('/pipeline');
      await page.getByRole('button', { name: 'New quote' }).click();
      const builder = page.locator('section.card', { has: page.getByRole('heading', { name: 'Build a quote' }) });
      await expect(builder).toBeVisible();
      await builder.getByPlaceholder('Search by name, email, or phone').fill(scorp.ownerEmail);
      const candidate = builder.locator('button.chip', { hasText: 'Synthetic' }).first();
      await expect(candidate, 'the owner is found by the address the proposal will go to').toBeVisible();
      await candidate.click();
      await builder.getByLabel(/^Business/).selectOption(scorp.businessId);
      // The catalog is grouped rows (2026-09-20): the filter finds the form number, the row's Add puts it on the quote.
      await builder.getByPlaceholder('Filter by name, form number or group').fill(scorp.itemCode);
      const bookRow = builder.locator('.qb-row', { hasText: '1120-S' }).first();
      await expect(bookRow, 'the 1120S line is in the price book in force').toBeVisible();
      await bookRow.getByRole('button', { name: /^Add / }).click();
      await expect(builder.locator('table.qb-lines'), 'the line is on "This quote"').toContainText('1120-S');
      await expect(builder.getByText(/Tax year —/), 'the builder names the year the return is for').toBeVisible();
      await expect(builder.locator('.builder-summary'), "the summary carries the line's price-book deposit").toContainText('Deposit');
      await builder.getByRole('button', { name: 'Save as draft' }).click();
      await expect(builder.getByText('Draft saved.')).toBeVisible();

      // The deposit override: its own panel, its own reason (deposits.override — the CEO alone holds it).
      await builder.getByRole('button', { name: 'Waive deposit…' }).click();
      const waive = builder.locator('.alert.warn', { hasText: 'Waive the deposit' });
      await expect(waive).toBeVisible();
      await waive.getByRole('button', { name: 'Waive deposit' }).click();
      await expect(waive.getByText(/at least a few words/), 'a waiver with no reason is refused in the panel').toBeVisible();
      await waive.locator('textarea').fill('The firm is filing its own return; no deposit is collected from this client.');
      await waive.getByRole('button', { name: 'Waive deposit' }).click();
      await expect(builder.getByText('WAIVED', { exact: true }), 'the server says waived and the panel reads it back').toBeVisible();
      await expect(builder.getByText(/no deposit is collected from this client/).first(), 'with the reason on the record').toBeVisible();

      await builder.getByRole('button', { name: /^Send to client/ }).click();
      const sentModal = page.locator('[role=dialog]', { hasText: 'Quote sent to' });
      await expect(sentModal).toBeVisible();
      await expect(sentModal, 'the confirmation names what the client will be asked for').toContainText('Deposit waived');
      await sentModal.getByRole('button', { name: 'Dismiss' }).click();
      steps.push(`A2|/pipeline button "New quote" → client search, "Business" select, price-book row ${scorp.itemCode} "Add", "Save as draft", "Waive deposit…" (reason), "Waive deposit", "Send to client"|ceo (quotes.manage + deposits.override)|tap`);

      // ── 3a. THE CLIENT ACCEPTS, on the link the proposal emailed them.
      const fresh = (await quoteLinksSoFar()).slice(tokensBefore);
      expect(fresh.length, 'the proposal email reached the harness mailer with its link').toBeGreaterThan(0);
      // The href as emailed, and the recipient is a migrated client with a portal account: no session, no redirect.
      await page.goto(fresh[fresh.length - 1]!);
      await expect(page.getByRole('heading', { name: 'Your proposal' })).toBeVisible();
      const proposal = await page.evaluate(() => document.body.innerText);
      expect(proposal, 'the proposal names the return').toContain('1120-S');
      expect(proposal, 'and tells them the deposit was waived before they accept').toContain('Waived — no deposit is asked for');
      await page.getByRole('button', { name: 'Accept and start the work' }).click();
      await expect(page.getByRole('heading', { name: 'You’re all set' }), 'the acceptance lands').toBeVisible();

      // The acceptance created the engagement and the return record. Found the way the screens find them.
      await page.goto(clientPage);
      const returns = (await read(page, `/tax-engagements?contactId=${scorp.contactId}`)).taxEngagements as Array<{ id: string; return_type: string; tax_year: number }>;
      expect(returns.length, 'the accepted business-tax quote created exactly one return record').toBe(1);
      const te = returns[0]!.id;
      expect(returns[0]!.return_type, 'an 1120S, from the line that was quoted').toBe('1120s');
      expect(returns[0]!.tax_year, 'for the year the builder offered').toBe(scorp.taxYear);
      const engagements = (await read(page, `/engagements?contactId=${scorp.contactId}`)).engagements as Array<{ id: string; service_line: string }>;
      const engagementId = engagements.find((e) => e.service_line === 'tax')!.id;

      // The packet the client signs, assembled by staff on the client page (Schedule B, from the return type).
      await expect(page.getByRole('heading', { name: 'Engagement packet' })).toBeVisible();
      /*
       * THE CONTROL IS ASSERTED BEFORE IT IS TAPPED, here and below. A click on a locator that
       * matches nothing waits out the whole test timeout; an expect on it fails in fifteen seconds.
       * The difference is what makes a sabotage on either packet control a red worth running.
       */
      const createPacket = page.getByRole('button', { name: 'Create engagement packet' });
      await expect(createPacket, 'the packet door is on the client page').toBeVisible();
      await createPacket.click();
      await expect(page.getByText(/^Packet created with B\b/), 'a business return resolves Schedule B, not A').toBeVisible();

      /*
       * A3b THE PACKET GOES OUT (R27, 2026-09-20). Creating it is half the door: the client is
       * emailed the Master when staff SEND it, and the row then says what it is waiting on. The
       * business path has the same two controls the individual one does — the manifest was the only
       * place that did not say so, because this walk had never annotated either of them.
       */
      const sendPacket = page.getByRole('button', { name: 'Send for signature' });
      await expect(sendPacket, 'the created packet offers the send').toBeVisible();
      await sendPacket.click();
      await expect(dialog, 'the send is confirmed in its own modal').toBeVisible();
      await dialog.getByRole('button', { name: 'Send for signature', exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expect(page.getByText(/Sent for signature\. The client was emailed the Master/), 'the send says what left').toBeVisible();
      await expect(page.getByText(/Waiting on the client.s signature/), 'and the row says what it now waits on').toBeVisible();
      steps.push('A3b|/clients/:id Engagement packet card, button "Create engagement packet" → button "Send for signature" (modal "Send this packet for signature?")|ceo (engagements.create)|tap');

      /*
       * GATE 1 IS THE CLIENT'S OWN TAP NOW (R10, 2026-09-20). The return is created unstamped — the
       * contact has no standing letter yet — and the pipeline refuses every stage past Scheduled
       * until it is. Nothing is posted here: the signature in the portal, three lines below, is what
       * stamps it, and A4a reads the stamp back off the return before walking a single stage.
       */
      const beforeSignature = (await read(page, `/tax-engagements/${te}`)).taxEngagement as Record<string, unknown>;
      expect(beforeSignature.engagement_letter_signed_at, 'the new return carries no engagement letter yet').toBeNull();

      // ── 3b. THE CLIENT'S OWN SESSION: sign the agreement, answer the questionnaire, upload a document.
      await signInPortal(page, scorp.portalMagicLinks[0]!);
      await page.goto(`${PORTAL}/sign`);
      const packetCard = page.locator('section.card', { has: page.getByRole('heading', { name: 'Your engagement agreement' }) });
      await expect(packetCard).toBeVisible();
      await expect(packetCard, 'the document they are signing carries Schedule B').toContainText('Schedule B');
      for (const box of await packetCard.locator('input[type=checkbox]').all()) await box.check();
      await packetCard.getByLabel('Type your full name to sign').fill(`Synthetic ${scorp.markers.business} Owner`);
      await packetCard.getByRole('button', { name: 'Sign the agreement' }).click();
      await expect(page.getByRole('heading', { name: 'Signed — thank you' }), 'the signature is recorded').toBeVisible();

      /*
       * A3c THE §7216 CONSENT, ON ITS OWN SCREEN (R27, 2026-09-20). The business path shows it too:
       * the USE consent is offered to EVERY client once the Master is signed — entity or individual,
       * consentsToPresent draws no line there — so the onward button on the thank-you reads Continue
       * and routes to /consent rather than home. Rev. Proc. 2013-14: that screen's content pertains
       * solely to the consent, and a decline sits on it with the same weight as a yes.
       */
      const onward = page.getByRole('button', { name: 'Continue', exact: true });
      await expect(onward, 'the thank-you reads Continue, which is the label a consent being owed puts on it').toBeVisible();
      await onward.click();
      await expect(page, 'a consent is owed, so the thank-you hands the owner to its own screen').toHaveURL(/\/consent$/);
      await expect(page.getByRole('button', { name: 'No, thank you' }), 'a decline carries the same weight as a yes').toBeVisible();
      const consentYes = page.getByRole('button', { name: 'Yes, you have my permission' });
      await expect(consentYes, 'and the screen offers the answer').toBeVisible();
      await consentYes.click();
      await expect(page.getByRole('heading', { name: 'Permission given. You can withdraw it any time.' }), 'the answer is recorded').toBeVisible();
      steps.push(`A3c|portal /consent (its own screen, reached from the signed packet), button "Yes, you have my permission"|${CLIENT_ROLE}|tap`);

      await page.goto(`${PORTAL}/questionnaire`);
      await expect(page.getByRole('heading', { name: 'A few questions about how you work' })).toBeVisible();
      // One module per screen and nothing on any of them is required: Continue to the end, then send.
      for (let i = 0; i < 15; i++) {
        const next = page.getByRole('button', { name: 'Continue', exact: true });
        if ((await next.count()) === 0) break;
        await next.click();
        await page.waitForTimeout(400);
      }
      await page.getByRole('button', { name: 'Send it' }).click();
      await expect(page.getByRole('heading', { name: 'Thank you — that is everything we needed' }), 'the business onboarding form is submitted').toBeVisible();

      await page.goto(`${PORTAL}/documents`);
      await page.getByLabel('Category').selectOption('business_records');
      await page.locator('input[type=file]').setInputFiles({ name: scorp.markers.document, mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 synthetic bank statement\n%%EOF') });
      await expect(page.getByText('Uploaded — thank you!')).toBeVisible();
      await expect(page.getByText(scorp.markers.document), 'the document is in their Document Center').toBeVisible();
      steps.push(`A3|portal /quote/:token button "Accept and start the work"; /sign (two affirmations + "Type your full name to sign" + "Sign the agreement", Schedule B on the document — the signature stamps the engagement letter on the return, closing pipeline gate 1); /questionnaire "Continue"…"Send it"; /documents "Category" + input[type=file]|${CLIENT_ROLE}|tap`);

      // ── 4a. THE PREPARER, THE EXTENSION, THE ESTIMATE AND THE STAGES, from the return's row.
      await page.goto(clientPage);
      const card = page.locator('section.card', { has: page.getByRole('heading', { name: 'Returns' }) });

      /*
       * R10 READ BACK: the client's signature in the portal stamped the engagement letter on the
       * return, so gate 1 is closed without a single staff keystroke — and the paper lane's door is
       * gone from the row, because there is nothing left for it to stamp. (A client who signs across
       * the desk instead taps that door; this one did not, so its absence is the proof.)
       */
      const afterSignature = (await read(page, `/tax-engagements/${te}`)).taxEngagement as Record<string, unknown>;
      expect(afterSignature.engagement_letter_signed_at, "the client's portal signature stamped the letter on the return").toBeTruthy();
      await expect(card.getByTestId('upload-engagement-letter'), 'the paper door leaves the row once the letter is on the return').toHaveCount(0);

      /*
       * R11 WHO PREPARES IT. The fixture has exactly one active tax preparer, so the row already
       * reads her name and the select opens on her — and she is chosen anyway, by hand, because the
       * walk must prove the control works and not that the default happens to be right.
       */
      await expect(card.getByText(`Preparer: ${scorp.preparer.name}`), "the firm's only tax preparer is the new return's default").toBeVisible();
      await card.getByTestId('assign-preparer').click();
      await expect(dialog.getByTestId('preparer-select'), 'the modal asks who prepares it').toBeVisible();
      await dialog.getByTestId('preparer-select').locator('select').selectOption(scorp.preparer.id);
      await dialog.getByRole('button', { name: 'Assign preparer' }).click();
      await expect(dialog).toHaveCount(0);
      await expect(card.getByText(`Preparer: ${scorp.preparer.name}`), 'the row names the preparer it was given').toBeVisible();
      steps.push(`A4|/clients/:id Returns card, button "Assign preparer" (modal: "Preparer" select) → the row reads "Preparer: ${scorp.preparer.name}"|${ROLES}|tap`);

      /*
       * R12 THE EXTENSION THAT WENT IN. An 1120S extends on Form 7004 — the select opens on it from
       * the return type — and the only other answer is the day it was filed. NO DEADLINE IS TYPED:
       * the route derives it from the return type and the fiscal year end, and the badge on the row
       * is read back against what the record says it derived.
       */
      await card.getByTestId('record-extension').click();
      await expect(dialog.getByTestId('extension-form'), 'the modal asks which form went in').toBeVisible();
      await expect(dialog.getByTestId('extension-form').locator('select'), 'an entity return opens on 7004, from its return type').toHaveValue('7004');
      await dialog.getByLabel('Date filed').fill(today);
      await dialog.getByRole('button', { name: 'Record extension' }).click();
      await expect(dialog).toHaveCount(0);
      const extended = (await read(page, `/tax-engagements/${te}`)).taxEngagement as Record<string, unknown>;
      expect(extended.extension_filed, 'the return is on extension').toBe(true);
      expect(extended.extension_form, 'on the form the modal offered for an 1120S').toBe('7004');
      expect(String(extended.extended_deadline) > String(extended.original_deadline), 'the derived deadline is later than the original').toBe(true);
      await expect(
        card.getByText(`Extended · Form 7004 · deadline ${dayText(String(extended.extended_deadline))}`),
        'the badge names the form and the deadline the route derived'
      ).toBeVisible();
      steps.push(`A4|/clients/:id Returns card, button "Record extension" (modal: "Extension form" 7004, "Date filed") → the badge reads the form and the derived deadline|${ROLES}|tap`);

      await card.getByRole('button', { name: 'Lock estimate' }).click();
      await expect(dialog.getByText(/Quoted:/), 'the modal reads the range off the price book version that priced it').toBeVisible();
      await dialog.getByRole('button', { name: 'Lock estimate' }).click();
      await expect(dialog).toHaveCount(0);
      await expect(card.getByText(/Estimate locked/), 'preparation is unlocked (gate 2)').toBeVisible();
      for (const label of ['Schedule', 'Request documents', 'Start preparation', 'Internal review']) {
        await card.getByRole('button', { name: label, exact: true }).click();
        await dialog.getByRole('button', { name: label, exact: true }).click();
        await expect(dialog, `${label} is confirmed in its own modal`).toHaveCount(0);
        await page.waitForTimeout(400);
      }
      const walked = (await read(page, `/tax-engagements/${te}`)).taxEngagement as Record<string, unknown>;
      expect(walked.stage, 'the return was walked to internal review, one legal stage at a time').toBe('internal_review');
      steps.push(`A4|/clients/:id Returns card, button "Lock estimate" (modal), then the legal next stage buttons "Schedule", "Request documents", "Start preparation", "Internal review"|${ROLES}|tap`);

      // ── 4b. DELIVER THE RETURN, on /upload-return: it lands in My Returns and the stage moves back
      //    to client review, which is where the client's copy of the return belongs.
      await page.goto('/upload-return');
      await expect(page.getByRole('heading', { name: 'Deliver a return' })).toBeVisible();
      await page.getByLabel('Find the client').fill(scorp.ownerEmail);
      await page.getByLabel('Find the client').press('Enter');
      await page.locator('button.btn.ghost', { hasText: scorp.ownerEmail }).click();
      await expect(page.getByLabel('Tax engagement')).toHaveValue(te);
      await expect(page.getByLabel('Tax year')).toHaveValue(String(scorp.taxYear));
      await page.locator('input[type=file]').setInputFiles({ name: scorp.markers.returnFile, mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 synthetic 1120S return\n%%EOF') });
      await expect(page.getByText('Delivered — stage moved to Client Review and the client was notified.')).toBeVisible();
      steps.push('A4|/upload-return "Find the client" + the client button, "Tax engagement" select, input[type=file] (Final return PDF, from ATX)|ceo, tax_preparer (documents.write)|tap');

      // ROLE PROOF: Jaqueline (ed_coo) holds engagements.read, so the return row is on her page, and no
      // engagements.tax.manage, so none of its controls are. (Laura, va_entity, sees no returns at all.)
      await signIn(page, fixtures.wall.jaqueline);
      await page.goto(clientPage);
      await expect(page.getByRole('heading', { name: 'Returns' })).toBeVisible();
      await expect(page.getByText(/1120S/).first(), 'the return row is on her page').toBeVisible();
      await page.waitForTimeout(800);
      for (const name of ['Set final fee', 'Lock estimate', 'Ready to file', 'Mark filed', 'Assign preparer']) {
        await expect(page.getByRole('button', { name }), `${name} is not on Jaqueline's page`).toHaveCount(0);
      }
      // The 2026-09-20 controls are behind the same permission, testids and all.
      for (const id of ['upload-signed-8879', 'upload-engagement-letter', 'assign-preparer', 'record-extension', 'jurisdiction-status']) {
        await expect(page.getByTestId(id), `${id} is not on Jaqueline's page`).toHaveCount(0);
      }
      steps.push(`A7|role proof: ed_coo sees the return row on /clients/:id and none of its controls|${ROLES}|tap`);

      // 6. THE SIGNED 8879-CORP, from the return's row. A future date is refused beside the date; the real, past date authorizes.
      await signIn(page, fixtures.staff);
      await page.goto(clientPage);
      const uploadBtn = page.getByTestId('upload-signed-8879');
      await expect(uploadBtn).toBeVisible();
      const pdf = { name: 'HARNESS-8879-CORP-SIGNED.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 synthetic 8879-CORP\n%%EOF') };
      await page.locator('input[type=file]').setInputFiles(pdf);
      await page.getByLabel('Signed on').fill(plusDays(2));
      await page.getByLabel('PTIN holder').selectOption(scorp.preparer.id);
      await uploadBtn.click();
      const dateError = page.locator('label', { hasText: 'Signed on' }).locator('.field-error');
      await expect(dateError, 'a signed date after today is refused beside the date').toContainText('is after today');
      await expect(page.getByLabel('Signed on'), 'the date stays for correction').toHaveValue(plusDays(2));
      const signedOn = '2026-09-10';
      await page.getByLabel('Signed on').fill(signedOn);
      await uploadBtn.click();
      await expect(uploadBtn, 'the upload is the authorization; the control leaves once it is on file').toHaveCount(0);
      await expect(page.getByText('No signed authorization on file')).toHaveCount(0);
      const rec = (await read(page, `/tax-engagements/${te}`)).taxEngagement as Record<string, unknown>;
      expect(String(rec.f8879_signed_on ?? rec.f8879_signed_at ?? '').slice(0, 10), 'the signed date is the date on the scan').toBe(signedOn);
      steps.push(`A6|/clients/:id Returns card, input[type=file] + "Signed on" + "PTIN holder" + button "Upload the signed 8879"|${ROLES}|tap`);

      /*
       * 7. THE FINAL FEE, read against the quoted range under the price book that priced it. The
       * estimate was locked at that range a few steps ago, so a fee above its top is scope creep as
       * well as outside the range: the modal asks for the CATEGORY and the reason, and the route
       * refuses until it has both — naming which one is missing each time, beside the field.
       */
      await page.getByRole('button', { name: 'Set final fee' }).click();
      await expect(dialog).toBeVisible();
      const rangeLine = await dialog.getByText(/Quoted range:/).innerText();
      const amounts = [...rangeLine.matchAll(/\$([\d,]+\.\d{2})/g)].map((m) => Math.round(Number(m[1]!.replace(/,/g, '')) * 100));
      expect(amounts.length, `the modal names the quoted range and the price book version: ${rangeLine}`).toBeGreaterThan(0);
      expect(rangeLine).toMatch(/price book v\d+/);
      const finalFeeCents = amounts[amounts.length - 1]! + 10_000; // one hundred dollars above the top of the range
      await dialog.getByLabel(/Final fee/).fill((finalFeeCents / 100).toFixed(2));
      await expect(dialog.getByText('Outside the quoted range')).toBeVisible();
      await expect(dialog.getByTestId('scope-creep-category'), 'above the locked top, the category is asked for in the same modal').toBeVisible();
      await dialog.getByRole('button', { name: 'Set final fee' }).click();
      await expect(dialog.locator('#ask-error'), 'refused in the modal, in the server\'s words: the category first').toContainText('scope-creep category');
      await expect(dialog.getByLabel(/Final fee/), 'the amount stays').toHaveValue((finalFeeCents / 100).toFixed(2));
      await dialog.getByLabel('Scope-creep category').selectOption('additional_states');
      await dialog.getByRole('button', { name: 'Set final fee' }).click();
      await expect(dialog.locator('#ask-error'), 'a category on its own is not a reason').toContainText('a reason is missing');
      await dialog.getByLabel(/Reason/).fill('Additional state schedules were prepared beyond the quoted scope.');
      await dialog.getByRole('button', { name: 'Set final fee' }).click();
      await expect(dialog).toHaveCount(0);
      await expect(page.getByText(`current ${money(finalFeeCents)}`)).toBeVisible();

      // READY TO FILE, then MARK FILED with the PTIN holder: only the legal next transitions are offered.
      await page.getByRole('button', { name: 'Ready to file' }).click();
      await dialog.getByRole('button', { name: 'Ready to file' }).click();
      await expect(dialog).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Mark filed' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Ready to file' }), 'a stage already reached is not offered again').toHaveCount(0);
      await page.getByRole('button', { name: 'Mark filed' }).click();
      await expect(dialog.getByText('No signed authorization on file')).toHaveCount(0);
      await expect(dialog.getByLabel(/PTIN holder/), 'the PTIN holder defaults to the holder recorded on the signed 8879').toHaveValue(scorp.preparer.id);
      await expect(dialog.getByText(`Issues the final-fee invoice for ${money(finalFeeCents)}`)).toBeVisible();
      /*
       * R15: every declared jurisdiction carries how it went out, and this return went out
       * electronically to both — a current tax year has the e-file lane, so that is what the selects
       * open on and neither is touched. (Path B is the mixed filing: federal e-filed, IL on paper.)
       */
      for (const j of ['federal', 'IL']) {
        await expect(dialog.getByTestId(`filing-method-${j}`), `${j} opens on the lane this tax year has`).toHaveValue('efile');
      }
      await dialog.getByRole('button', { name: 'Mark filed' }).click();
      await expect(dialog).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Set final fee' }), 'the controls leave with the filing').toHaveCount(0);
      const invoices = (await read(page, `/invoices?contactId=${scorp.contactId}`)).invoices as Array<Record<string, unknown>>;
      const inv = invoices.find((i) => i.total_cents === finalFeeCents);
      expect(inv, 'the filing issued the final-fee invoice at the fee set on the row').toBeTruthy();
      expect(inv!.status, 'issued, so the client can pay it the moment the filing commits').toBe('sent');
      steps.push(`A7|/clients/:id Returns card, buttons "Set final fee" (modal: Final fee, "Scope-creep category", Reason), "Ready to file", "Mark filed" (modal: PTIN holder, Jurisdictions filed with a filing method per jurisdiction — E-filed for federal and IL)|${ROLES}|tap`);

      // 8. THE ATX ACKNOWLEDGMENT REPORT, on the E-file acks screen, as the CEO.
      const report = [
        'Entity Name,EIN,Tax Year,Return Type,Agency,Status,Submission ID,Ack Date,Reject Code,Reject Reason',
        `"${scorp.entityName}",${scorp.einLast4},${scorp.taxYear},1120S,Federal,Accepted,H-FED-1,${today.slice(5, 7)}/${today.slice(8, 10)}/${today.slice(0, 4)},,`,
        `"${scorp.entityName}",${scorp.einLast4},${scorp.taxYear},1120S,IL,Accepted,H-IL-1,${today.slice(5, 7)}/${today.slice(8, 10)}/${today.slice(0, 4)},,`,
      ].join('\n');
      await page.goto('/efile-acks');
      await expect(page.getByRole('heading', { name: 'E-file acknowledgments' })).toBeVisible();
      await page.locator('input[type=file]').setInputFiles({ name: 'HARNESS-ATX-ACK-1120S.csv', mimeType: 'text/csv', buffer: Buffer.from(report) });
      await expect(page.getByRole('status')).toContainText('2 will send');
      await expect(page.getByText(scorp.markers.business).first(), 'the report opened with its rows').toBeVisible();
      const text = await page.evaluate(() => document.body.innerText);
      expect(text, 'both rows matched the entity').toContain(scorp.markers.business);
      expect(text, 'the federal row will send').toMatch(/Federal[\s\S]*Will send/);
      expect(text, 'the Illinois row will send').toMatch(/\bIL\b[\s\S]*Will send/);
      await page.getByRole('button', { name: /^Release/ }).first().click();
      await page.locator('[role=dialog]').getByRole('button', { name: /^Release 2/ }).click();
      await expect(page.getByRole('status')).toContainText('Released: 2 queued to send');
      steps.push('A8|/efile-acks input[type=file], the review rows, button "Release" + modal "Release 2"|ceo (efile.manage)|tap');

      // 9. The harness API drains the outbox every two seconds; the rows say sent when it has.
      let acksSent = 0;
      for (let i = 0; i < 90 && acksSent < 2; i++) {
        await page.waitForTimeout(1000);
        const view = await read(page, '/efile-acks');
        const rep = (view.reports as Array<{ id: string }>)[0];
        const rows = (await read(page, `/efile-acks/${rep!.id}`)).rows as Array<{ disposition: string }>;
        acksSent = rows.filter((r) => r.disposition === 'sent').length;
      }
      expect(acksSent, 'two acceptance emails left').toBe(2);
      // The screen, reopened the way a person would after the sweep: the report from the list, its rows reading Sent.
      await page.reload();
      await page.getByRole('button', { name: 'Open' }).first().click();
      await expect(page.getByText('Sent', { exact: true }).first(), 'the screen reads sent').toBeVisible();
      await page.screenshot({ path: shot, fullPage: true });
      const acked = (await read(page, `/tax-engagements/${te}`)).taxEngagement as Record<string, unknown>;
      expect(acked.stage, 'federal and Illinois both accepted complete the return').toBe('completed');
      expect(acked.state_accepted_code, 'Illinois accepted beside it').toBe('IL');
      const engagement = ((await read(page, `/engagements?contactId=${scorp.contactId}`)).engagements as Array<Record<string, unknown>>).find((e) => e.id === engagementId)!;
      expect(engagement.status, 'every return filed and accepted closes the engagement').toBe('completed');
      expect(engagement.open_balance_cents, 'the completed engagement carries its unpaid invoice as an open balance').toBe(finalFeeCents);
      steps.push('A9|/efile-acks reopened from the list (button "Open"), both rows reading Sent|ceo (efile.manage)|tap');

      // The completed engagement with its invoice unpaid: the open balance on the client page and on the executive view.
      await page.goto(clientPage);
      await expect(page.getByTestId('engagement-open-balance').first()).toContainText(`Open balance ${money(finalFeeCents)}`);
      const execBefore = await read(page, '/dashboards/executive');
      const moneyBefore = execBefore.moneyActionsToday as Array<{ actor: string }>;
      const unpaidBefore = execBefore.completedUnpaid as { count: number; balanceCents: number } | undefined;
      expect(unpaidBefore, 'the executive view counts completed engagements with an open balance').toBeTruthy();

      /*
       * 10. THE PAYMENT. The client's tap is Pay now in the portal, and that tap is the walk step:
       * the harness asserts the Checkout URL it navigated to and fulfils the request itself, so no
       * external host is ever loaded. STRIPE_MODE is stub here, so the host is
       * checkout.stripe.example and the session id is the stub's `cs_stub_<invoice>`; under a live
       * test key the same tap navigates to a checkout.stripe.com session — the host and the id
       * change, the control and the assertion do not. The money moves on the event Stripe posts,
       * which is an API call and is annotated as one.
       */
      let checkoutUrl = '';
      await page.route('https://checkout.stripe.example/**', async (route) => {
        checkoutUrl = route.request().url();
        await route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body>harness: Stripe Checkout is never loaded</body></html>' });
      });
      await page.goto(`${PORTAL}/invoices`);
      const payRow = page.locator('li', { hasText: money(finalFeeCents) }).first();
      await expect(payRow, "the final-fee invoice is on the client's Invoices page").toBeVisible();
      await payRow.getByRole('button', { name: 'Pay now' }).click();
      await page.waitForURL(/checkout\.stripe\.example/, { timeout: 30_000 });
      expect(checkoutUrl, 'the tap navigated to the Checkout session the API minted for this invoice').toBe(`https://checkout.stripe.example/cs_stub_${String(inv!.id)}`);
      await page.unroute('https://checkout.stripe.example/**');
      steps.push('A10|portal /invoices, the final-fee row, button "Pay now" → navigates to the Stripe Checkout session the API minted for that invoice|client (portal session)|tap');

      await page.goto(clientPage);
      const paid = await page.evaluate(async ({ id, secret, vp }) => {
        const r = await fetch('/api/webhooks/stripe', { method: 'POST', headers: { 'content-type': 'application/json', 'x-webhook-secret': secret }, body: JSON.stringify({ id: `evt_harness_scorp_paid_${vp}`, type: 'checkout.session.completed', data: { object: { id: `cs_stub_${id}`, payment_intent: `pi_harness_scorp_${vp}`, metadata: { invoice_id: id } } } }) });
        return r.status;
      }, { id: String(inv!.id), secret: scorp.webhookSecret, vp: viewport });
      expect(paid, 'the payment event').toBeLessThan(300);
      const afterPay = ((await read(page, `/invoices?contactId=${scorp.contactId}`)).invoices as Array<Record<string, unknown>>).find((i) => i.id === inv!.id)!;
      expect(afterPay.status, 'paid').toBe('paid');
      const receipt = (afterPay.notices as Array<{ kind: string; state: string }> | undefined)?.find((n) => n.kind === 'payment_receipt');
      expect(receipt?.state, 'the payment receipt left').toBe('delivered');
      steps.push("A10|the checkout.session.completed event posted to /webhooks/stripe (Stripe's call, not a tap)|Stripe|api");

      // 11. The dashboard's money line: nothing new, because the actor on every step was the CEO. The unpaid
      // completed count drops by one now the invoice is paid.
      const execAfter = await read(page, '/dashboards/executive');
      const moneyAfter = execAfter.moneyActionsToday as Array<{ actor: string }>;
      expect(moneyAfter.length, 'the fee, the filing, the payment and the completion added no staff money action').toBe(moneyBefore.length);
      expect(moneyAfter.some((m) => /Walker/.test(m.actor)), 'none of it is the CEO').toBe(false);
      const unpaidAfter = execAfter.completedUnpaid as { count: number; balanceCents: number };
      // The harness owner is a test client, and the executive count leaves test clients out by design: the number does not move.
      expect(unpaidAfter.balanceCents, 'a test client never reaches the executive count').toBe(unpaidBefore!.balanceCents);
      await page.goto('/');
      await expect(page.getByTestId('money-actions-today')).toContainText(`Money actions today by staff: ${moneyAfter.length}`);
      await expect(page.getByTestId('money-outside-the-door')).toContainText('Money moved outside the door today:');
      await expect(page.getByTestId('completed-unpaid')).toBeVisible();
      await page.goto(clientPage);
      await expect(page.getByTestId('engagement-open-balance'), 'the open balance is gone once paid').toHaveCount(0);
      steps.push('A11|/ (executive view) money line, outside-the-door line, completed-unpaid tile; /clients/:id engagement row without an open balance|ceo|tap');
      passed = true;
    } finally {
      if (!existsSync(shot)) await page.screenshot({ path: shot, fullPage: true }).catch(() => undefined);
      testInfo.annotations.push({ type: 'screenshot', description: keepScreenshot(`scorp-dry-run-acks-${viewport}`, passed, shot) });
      for (const s of steps) testInfo.annotations.push({ type: 'walk-step', description: s });
    }
  });

  test('the client page reads the finished run: filed and accepted, the return delivered, the invoice paid, the engagement completed', async ({ page }, testInfo) => {
    const viewport = testInfo.project.name;
    const scorp = scorpFor(viewport);
    const shot = testInfo.outputPath(`scorp-done-${viewport}.png`);
    let passed = false;
    try {
      await signIn(page, fixtures.staff);
      await page.goto(`/clients/${scorp.contactId}`);
      await expect(page.getByRole('heading', { name: /Documents \(/ })).toBeVisible();
      await page.waitForTimeout(1500);
      const text = await page.evaluate(() => document.body.innerText);
      expect(text, 'the entity is on the page').toContain(scorp.markers.business);
      expect(text, 'the delivered return is filed under the client').toContain(scorp.markers.returnFile);
      expect(text, 'so is the document the client uploaded').toContain(scorp.markers.document);
      expect(text, 'the packet carries Schedule B').toMatch(/Packet\s*B\b/);
      expect(text, 'the return reads completed').toMatch(/completed/i);
      expect(text, 'the invoice reads paid').toMatch(/Paid/);
      expect(text, 'no open balance once paid').not.toMatch(/Open balance/);
      expect(text, 'no period badge on a completed business return is a lie either way; the year is on the return').not.toMatch(/period not recorded/);
      expect(text, 'nothing on the page is a raw ISO timestamp').not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
      /*
       * The record behind the taps: the quote the client accepted carries the waived deposit, and the
       * packet they signed carries Schedule B and nothing else. These were the fixture's assertions
       * when the fixture built this; they are the walk's now.
       */
      const quotes = (await read(page, `/contacts/${scorp.contactId}/quotes`)).quotes as Array<{ id: string; status: string }>;
      const accepted = quotes.find((q) => q.status === 'accepted');
      expect(accepted, 'the quote the client accepted is on the record').toBeTruthy();
      const deposit = (await read(page, `/quotes/${accepted!.id}`)).deposit as Record<string, unknown>;
      expect(deposit.chargeCents, 'the deposit resolved to $0').toBe(0);
      expect(deposit.treatment, 'recorded as waived').toBe('waived');
      const packets = (await read(page, `/contacts/${scorp.contactId}/packets`)).packets as Array<{ schedule_codes: string[]; status: string }>;
      expect(packets[0]!.schedule_codes, 'the packet resolved Schedule B and not A').toEqual(['B']);
      expect(packets[0]!.status, 'signed in the portal by the owner').toBe('signed');
      const returns = (await read(page, `/tax-engagements?contactId=${scorp.contactId}`)).taxEngagements as Array<{ id: string; return_type: string }>;
      const detail = (await read(page, `/tax-engagements/${returns[0]!.id}`)).taxEngagement as Record<string, unknown>;
      expect(detail.return_type, 'the return is the 1120S the quote created').toBe('1120s');
      expect(detail.business_id, "and it is against the entity the quote named").toBe(scorp.businessId);
      await page.screenshot({ path: shot, fullPage: true });
      passed = true;
    } finally {
      if (!existsSync(shot)) await page.screenshot({ path: shot, fullPage: true }).catch(() => undefined);
      testInfo.annotations.push({ type: 'screenshot', description: keepScreenshot(`scorp-done-${viewport}`, passed, shot) });
      testInfo.annotations.push({ type: 'walk-step', description: `A11|/clients/:id read at ${viewport}: return completed, invoice paid, engagement completed, no open balance|ceo|tap` });
    }
  });
});
