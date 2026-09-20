/*
 * PATH B — THE 1040 ON EXTENSION, WALK-IN WET SIGNATURE (Brian, 2026-09-19 evening, BUILD 4).
 *
 * One person, one return, fifteen steps, at 390 and again at 1280. Everything a person does is
 * done here through the screen they would touch: the quote built and sent from /pipeline, the
 * proposal accepted and the deposit paid in the portal, the packet created and sent from the
 * client page, the §7216 consent answered on its own screen, the questionnaire submitted, a
 * document uploaded by the client, the return delivered on /upload-return, the wet-signed 8879
 * uploaded to the return's row, the final fee set, the return filed with the PTIN holder, the
 * acknowledgment report uploaded and released, and the final invoice paid.
 *
 * THE FOUR THINGS THAT ARE NOT TAPS, AND WHY (each reported as a defect, annotated how=fixture
 * or how=api so the evidence table says so rather than implying a screen exists):
 *
 *   B1  Ops has NO create-contact screen. /clients searches and nothing in apps/internal posts
 *       to /contacts, so the person cannot be created by hand at all. The fixture inserts them.
 *   --  THE EXTENSION has no control either. `extension_filed` is written only by
 *       POST /tax-engagements/:id/extension/filed, which no page in Ops calls; the client page
 *       renders the "extended" badge it produces and offers no way to produce it. The harness
 *       posts the route once the return exists (it cannot exist earlier — acceptance creates it)
 *       and reads the derived extended deadline back. The date is never typed.
 *   --  THE ENGAGEMENT LETTER ON THE RETURN is the same shape: the client signing the packet in
 *       the portal sets contacts.engagement_letter_status, and nothing sets the RETURN's
 *       engagement_letter_signed_at, which is gate 1 on every stage past Scheduled. The only
 *       writer is POST /tax-engagements/:id/signatures/wet, staff-only, on no screen. So the
 *       client signs, and the harness records it through the route.
 *   B3/B14 THE CARD ITSELF is Stripe's. The Pay control is tapped, the navigation to the
 *       Checkout URL the stub adapter returns is asserted (intercepted — the harness never loads
 *       an external host), and the payment event Stripe would send is posted to /webhooks/stripe.
 *
 * Each step pushes a walk-step annotation that scripts/walk-evidence.mjs reads into the report.
 * Each viewport walks its own synthetic person (pathB.phone / pathB.desk), because the walk
 * mutates its client once.
 */
import { expect, test, type Page } from '@playwright/test';
import * as OTPAuth from 'otpauth';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..');
interface Persona { email: string; password: string; totpSecret: string }
interface PathBPerson {
  contactId: string; ownerEmail: string; firstName: string; lastName: string;
  ssnLast4: string; state: string; portalMagicTokens: string[];
}
const fixtures = JSON.parse(readFileSync(resolve(here, '..', '.artifacts', 'fixtures.json'), 'utf8')) as {
  staff: Persona;
  portalPort?: number;
  pathB: {
    phone: PathBPerson; desk: PathBPerson;
    item: { code: string; name: string };
    addOn: { code: string; name: string };
    preparer: { id: string; name: string };
    webhookSecret: string;
  } | null;
};
const PORTAL = `http://localhost:${fixtures.portalPort ?? 3106}`;
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
const usDate = (iso: string): string => `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(0, 4)}`;
const money = (cents: number): string => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const rx = (s: string): RegExp => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

/** The roles behind each door, as the routes require them — the evidence table's roles column. */
const ROLES = {
  quote: 'ceo (engagements.tax.manage)',
  packet: 'ceo (engagements.create)',
  returnControls: 'tax_preparer, ceo (engagements.tax.manage)',
  documents: 'ceo (documents.write)',
  efile: 'ceo (efile.manage)',
  client: 'client (portal sign-in link)',
};

/** The client's copy, from apps/portal/lib/i18n.ts — hard-coded so a wrong translation cannot agree with itself. */
const COPY = {
  quoteTitle: 'Your proposal',
  accept: 'Accept and start the work',
  accepted: 'You’re all set',
  pay: 'Pay now',
  paid: 'Paid',
  packetTitle: 'Your engagement agreement',
  signName: 'Type your full name to sign',
  sign: 'Sign the agreement',
  signed: 'Signed — thank you',
  onward: 'Continue',
  consentYes: 'Yes, you have my permission',
  consentNo: 'No, thank you',
  consentRecorded: 'Permission given. You can withdraw it any time.',
  questTitle: 'A few questions about how you work',
  questNext: 'Continue',
  questSubmit: 'Send it',
  questDone: 'Thank you — that is everything we needed',
  docsCategory: 'Category',
  docsUploaded: 'Uploaded — thank you!',
  returnsTitle: 'My Returns',
};

async function signInStaff(page: Page, who: Persona): Promise<void> {
  const code = new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(who.totpSecret) }).generate();
  await page.goto('/login');
  const status = await page.evaluate(async ({ email, password, totp }) => {
    const r = await fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password, totp }) });
    sessionStorage.setItem('saos_staff_authed', '1');
    return r.status;
  }, { email: who.email, password: who.password, totp: code });
  expect(status, `${who.email} signs in`).toBe(200);
}

/** The client's own way in: the link they were emailed, redeemed. Single use, so once per run. */
async function signInPortal(page: Page, token: string): Promise<void> {
  await page.goto(`${PORTAL}/login`);
  const status = await page.evaluate(async (t) => {
    const r = await fetch('/api/portal/auth/magic/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: t }) });
    localStorage.setItem('saos_portal_authed', '1');
    return r.status;
  }, token);
  expect(status, 'redeeming the sign-in link the client was emailed').toBe(200);
}

/** A read of the API from the signed-in session, for state the screen does not print. */
async function read(page: Page, path: string): Promise<Record<string, unknown>> {
  return page.evaluate(async (p) => (await fetch(`/api${p}`)).json().catch(() => ({})), path);
}
/** A write the screens do not offer — each one is a reported defect, never a convenience. */
async function post(page: Page, path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  return page.evaluate(async ({ p, b }) => {
    const r = await fetch(`/api${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
    return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, unknown> };
  }, { p: path, b: body });
}

function keepScreenshot(name: string, passed: boolean, file: string): string {
  const dir = passed ? resolve(here, '..', '.artifacts', today) : resolve(root, 'tasks', 'walks', today);
  mkdirSync(dir, { recursive: true });
  const target = resolve(dir, `${name}.png`);
  if (existsSync(file)) copyFileSync(file, target);
  return target;
}

/** Click a control on the page, then the same-named confirmation in the modal it raises. */
async function confirm(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name, exact: true }).first().click();
  const dialog = page.locator('[role=dialog]');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name, exact: true }).click();
  await expect(dialog).toHaveCount(0);
}

test.describe('Path B', () => {
  test('the 1040 on extension: quoted, deposit paid, papered, consented, prepared, delivered, wet-signed, filed, acknowledged, paid, completed', async ({ page }, testInfo) => {
    const viewport = testInfo.project.name; // phone | desk
    const pathB = fixtures.pathB;
    expect(pathB, 'the Path B fixture is built (apps/api/scripts/e2e-fixtures/path-b.ts)').toBeTruthy();
    const who = viewport === 'desk' ? pathB!.desk : pathB!.phone;
    const fullName = `${who.firstName} ${who.lastName}`;
    const clientPage = `/clients/${who.contactId}`;
    const preparer = pathB!.preparer;
    const PDF = { mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 synthetic harness document — no real client data\n%%EOF') };
    test.setTimeout(900_000); // fifteen steps across two apps, plus a wait on the outbox sweep
    const shot = testInfo.outputPath(`path-b-${viewport}.png`);
    const steps: string[] = [];
    const defects: string[] = [];
    let passed = false;

    /* The card is Stripe's; the harness never loads an external host. */
    await page.route('https://checkout.stripe.example/**', (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body>harness checkout stub</body></html>' })
    );
    /** Tap Pay, land on the Checkout URL the stub returns, and come back with the invoice it was for. */
    const payTap = async (): Promise<string> => {
      await page.goto(`${PORTAL}/invoices`);
      const pay = page.getByRole('button', { name: COPY.pay });
      await expect(pay, 'exactly one invoice is payable').toHaveCount(1);
      await pay.click();
      await page.waitForURL(/^https:\/\/checkout\.stripe\.example\/cs_stub_/);
      const invoiceId = page.url().split('cs_stub_')[1]!;
      expect(invoiceId, 'the Checkout session names the invoice it is for').toMatch(/^[0-9a-f-]{36}$/);
      return invoiceId;
    };
    /** The event Stripe sends when the card clears. An API call, and reported as one. */
    const payEvent = async (invoiceId: string, tag: string): Promise<void> => {
      await page.goto(`${PORTAL}/invoices`);
      const status = await page.evaluate(async ({ id, secret, evt }) => {
        const r = await fetch('/api/webhooks/stripe', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-webhook-secret': secret },
          body: JSON.stringify({ id: evt, type: 'checkout.session.completed', data: { object: { id: `cs_stub_${id}`, payment_intent: `pi_harness_pathb_${evt}`, metadata: { invoice_id: id } } } }),
        });
        return r.status;
      }, { id: invoiceId, secret: pathB!.webhookSecret, evt: `evt_harness_pathb_${tag}_${viewport}` });
      expect(status, 'the payment event').toBeLessThan(300);
      await page.reload();
      await expect(page.getByRole('button', { name: COPY.pay }), 'the paid invoice offers no way to pay it again').toHaveCount(0);
      await expect(page.getByText(COPY.paid, { exact: true }).first(), 'the client reads it as paid').toBeVisible();
    };

    try {
      // ── B1. THE CONTACT — a defect: Ops cannot create one ───────────────────────────────
      await signInStaff(page, fixtures.staff);
      await page.goto('/clients');
      await expect(page.getByRole('heading', { name: 'Clients', exact: true })).toBeVisible();
      for (const name of [/^new client$/i, /^add client$/i, /^new contact$/i, /^add contact$/i, /^create client$/i]) {
        await expect(page.getByRole('button', { name }), 'the client directory offers no way to create a person').toHaveCount(0);
        await expect(page.getByRole('link', { name }), 'nor a link to one').toHaveCount(0);
      }
      await page.getByLabel('Search').fill(who.lastName);
      await expect(page.getByRole('link', { name: rx(fullName) }).first(), 'the person the fixture had to insert is findable').toBeVisible();
      defects.push('B1: Ops has no create-contact screen — /clients searches only, and nothing in apps/internal posts to /contacts. The fixture inserts the person.');
      steps.push(`B1|DEFECT — no control: /clients offers search only and no page in Ops posts to /contacts; the person is inserted by apps/api/scripts/e2e-fixtures/path-b.ts|${ROLES.quote}|fixture`);

      // ── B2. THE QUOTE, built from the price book and sent ───────────────────────────────
      await page.goto('/pipeline');
      await page.getByRole('button', { name: 'New quote' }).click();
      await page.getByPlaceholder('Search by name, email, or phone').fill(who.lastName);
      const chip = page.getByRole('button', { name: fullName, exact: true });
      await expect(chip).toBeVisible();
      await chip.click();
      for (const line of [pathB!.item.name, pathB!.addOn.name]) {
        await page.getByPlaceholder('Filter the price book').fill(line);
        const lineChip = page.getByRole('button', { name: rx(line) }).first();
        await expect(lineChip, `${line} is in the price book in force`).toBeVisible();
        await lineChip.click();
      }
      await expect(page.getByText(/summed from the lines. price-book deposits/), 'the base line carries a deposit, so acceptance has one to invoice').toBeVisible();
      await expect(page.getByText(/Tax year —/), 'the year the return is for, from the server').toBeVisible();
      /*
       * THE FEE THE WORK IS WORTH, read off the builder rather than typed: the committed total of
       * the two lines is what the preparer will record as the final fee at B13. The price never
       * leaves the price book — this is the figure the screen computed from it.
       */
      const committedLine = await page.getByText(/Committed total:/).innerText();
      const committedCents = Math.round(Number(/\$([\d,]+\.\d{2})/.exec(committedLine)![1]!.replace(/,/g, '')) * 100);
      expect(committedCents, `the builder's committed total: ${committedLine}`).toBeGreaterThan(0);
      await page.getByRole('button', { name: 'Create and send' }).click();
      const sent = page.locator('[role=dialog]');
      await expect(page.getByRole('heading', { name: `Quote sent to ${fullName}` })).toBeVisible();
      const quoteUrl = (await sent.locator('code').first().innerText()).trim();
      const quoteToken = quoteUrl.split('/').pop()!;
      expect(quoteToken.length, 'the proposal link the client was emailed').toBeGreaterThan(20);
      await sent.getByRole('button', { name: 'Dismiss' }).click();
      steps.push(`B2|/pipeline button "New quote" → "Client or lead" search + the client's chip → "Filter the price book" + the price-book chips for the base return and its schedule → button "Create and send"|${ROLES.quote}|tap`);

      // ── B3. ACCEPTED, AND THE DEPOSIT PAID ─────────────────────────────────────────────
      await page.goto(`${PORTAL}/quote/${quoteToken}`);
      await expect(page.getByRole('heading', { name: COPY.quoteTitle })).toBeVisible();
      await expect(page.getByText(/Deposit/).first(), 'the client reads the deposit before accepting').toBeVisible();
      await page.getByRole('button', { name: COPY.accept }).click();
      await expect(page.getByRole('heading', { name: COPY.accepted })).toBeVisible();
      await signInPortal(page, who.portalMagicTokens[0]!);
      const depositInvoiceId = await payTap();
      await payEvent(depositInvoiceId, 'deposit');
      steps.push(`B3|portal /quote/:token button "${COPY.accept}" → portal /invoices button "${COPY.pay}" → the Checkout URL the stub adapter returns (intercepted; never loaded)|${ROLES.client}|tap`);
      steps.push('B3|Stripe Checkout is outside SAOS; the harness posts the checkout.session.completed event to /webhooks/stripe with the harness webhook secret|client (card)|api');

      // ── THE RETURN EXISTS NOW: record the extension, and read the derived deadline back ──
      await page.goto(clientPage);
      const returns = (await read(page, `/tax-engagements?contactId=${who.contactId}`)).taxEngagements as Array<Record<string, unknown>>;
      expect(returns.length, 'accepting the quote created exactly one return').toBe(1);
      const te = String(returns[0]!.id);
      expect(returns[0]!.return_type, 'an individual base line names a 1040').toBe('1040');
      const taxYear = Number(returns[0]!.tax_year);
      const ext = await post(page, `/tax-engagements/${te}/extension/filed`, {});
      expect(ext.status, 'the extension is recorded').toBe(200);
      const onExtension = (await read(page, `/tax-engagements/${te}`)).taxEngagement as Record<string, unknown>;
      expect(onExtension.extension_filed, 'the return is on extension').toBe(true);
      expect(String(onExtension.extended_deadline), 'the extended deadline is derived from the return type and the year, never typed')
        .toBe(String(ext.json.extendedDeadline));
      expect(String(onExtension.extended_deadline) > String(onExtension.original_deadline), 'the extended deadline is later than the original').toBe(true);
      expect(Number(String(onExtension.extended_deadline).slice(0, 4)), 'a 1040 extends into the year after the tax year').toBe(taxYear + 1);
      await page.reload();
      await expect(page.getByText('extended').first(), 'the return\'s row says it is on extension').toBeVisible();
      defects.push('On extension: no Ops control writes extension_filed — POST /tax-engagements/:id/extension/filed is called by no page. The client page renders the badge it produces and offers no way to produce it.');

      // ── B4. THE ENGAGEMENT PACKET, assembled and sent ───────────────────────────────────
      await expect(page.getByRole('heading', { name: 'Engagement packet' })).toBeVisible();
      await page.getByRole('button', { name: 'Create engagement packet' }).click();
      await expect(page.getByText(/^Packet created with/), 'the packet names its schedules').toBeVisible();
      await confirm(page, 'Send for signature');
      await expect(page.getByText(/Sent for signature\. The client was emailed the Master/)).toBeVisible();
      await expect(page.getByText(/Waiting on the client.s signature/)).toBeVisible();
      steps.push(`B4|/clients/:id Engagement packet card, button "Create engagement packet" → button "Send for signature" (modal "Send this packet for signature?")|${ROLES.packet}|tap`);

      // ── B5. THE §7216 CONSENT, on its own screen, after the client signs ────────────────
      await page.goto(`${PORTAL}/sign`);
      await expect(page.getByRole('heading', { name: COPY.packetTitle })).toBeVisible();
      const boxes = page.locator('section.card input[type=checkbox]');
      await boxes.nth(0).check();
      await boxes.nth(1).check();
      await page.getByLabel(COPY.signName).fill(fullName);
      await page.getByRole('button', { name: COPY.sign }).click();
      await expect(page.getByRole('heading', { name: COPY.signed })).toBeVisible();
      await page.getByRole('button', { name: COPY.onward }).click();
      await expect(page).toHaveURL(/\/consent$/);
      await expect(page.getByRole('button', { name: COPY.consentNo }), 'a decline carries the same weight as a yes').toBeVisible();
      await page.getByRole('button', { name: COPY.consentYes }).click();
      await expect(page.getByRole('heading', { name: COPY.consentRecorded })).toBeVisible();
      steps.push(`B5|portal /consent (its own screen, reached from the signed packet), button "${COPY.consentYes}"|${ROLES.client}|tap`);

      // ── B6. THE ONBOARDING QUESTIONNAIRE ───────────────────────────────────────────────
      await page.goto(`${PORTAL}/questionnaire`);
      await expect(page.getByRole('heading', { name: COPY.questTitle })).toBeVisible();
      await page.getByRole('button', { name: COPY.questNext }).click(); // past "Your details"
      await expect(page.getByLabel(/Who prepared last year/)).toBeVisible();
      await page.getByLabel(/Who prepared last year/).selectOption('other_preparer');
      await page.getByLabel('Filing status').selectOption('single');
      await page.getByLabel('Dependents (count)').fill('0');
      await page.getByRole('button', { name: COPY.questSubmit }).click();
      await expect(page.getByRole('heading', { name: COPY.questDone })).toBeVisible();
      steps.push(`B6|portal /questionnaire, "${COPY.questNext}" past the details screen then the tax-onboarding module, button "${COPY.questSubmit}"|${ROLES.client}|tap`);

      // ── B7. A DOCUMENT UPLOADED BY THE CLIENT ──────────────────────────────────────────
      await page.goto(`${PORTAL}/documents`);
      const clientDoc = `HARNESS-PATHB-W2-${viewport}.pdf`;
      await page.getByLabel(COPY.docsCategory).selectOption('tax_documents');
      await page.locator('input[type=file]').setInputFiles({ name: clientDoc, ...PDF });
      await expect(page.getByText(COPY.docsUploaded)).toBeVisible();
      await expect(page.getByText(clientDoc)).toBeVisible();
      steps.push(`B7|portal /documents (Document Center), the "${COPY.docsCategory}" select + input[type=file]|${ROLES.client}|tap`);

      // ── THE RETURN WALKS TO INTERNAL REVIEW, from its own row ───────────────────────────
      // Gate 1 is the engagement letter ON THE RETURN, which the portal signature does not set.
      await page.goto(clientPage);
      const letter = await post(page, `/tax-engagements/${te}/signatures/wet`, { type: 'engagement_letter', note: 'The client signed the engagement agreement in the portal.' });
      expect(letter.status, 'the engagement letter is recorded against the return').toBe(200);
      defects.push('The engagement letter on the return: the client signing the packet in the portal sets contacts.engagement_letter_status and NOT tax_engagements.engagement_letter_signed_at, which is gate 1 past Scheduled. The only writer is POST /tax-engagements/:id/signatures/wet, on no screen.');

      await page.reload();
      await expect(page.getByRole('heading', { name: 'Returns' })).toBeVisible();
      /*
       * THE ESTIMATE IS LOCKED AT THE SCOPE THE CLIENT ACCEPTED. The modal prefills from the
       * quoted range, which on a return is the BASE price-book line alone (quotedRangeFor prices
       * the base item and nothing else) — so a quote with a schedule on it prefills LOW. The
       * preparer locks the top at the committed total of the accepted quote, which is the figure
       * the builder computed from the price book and the client agreed to. The final fee then
       * sits inside the locked estimate, where it belongs: this is quoted scope, not scope creep.
       */
      const lockDialog = page.locator('[role=dialog]');
      await page.getByRole('button', { name: 'Lock estimate' }).click();
      await expect(lockDialog.getByText(/Quoted:/), 'the modal names the quoted range and the price book version').toContainText(/price book v\d+/);
      await lockDialog.getByLabel('High end (dollars)').fill((committedCents / 100).toFixed(2));
      await lockDialog.getByRole('button', { name: 'Lock estimate' }).click();
      await expect(lockDialog).toHaveCount(0);
      await expect(page.getByText(/Estimate locked/)).toContainText(rx(money(committedCents)));
      for (const stage of ['Schedule', 'Request documents', 'Start preparation', 'Internal review']) {
        await confirm(page, stage);
      }
      const prepared = (await read(page, `/tax-engagements/${te}`)).taxEngagement as Record<string, unknown>;
      expect(prepared.stage, 'the return is ready for delivery').toBe('internal_review');

      // ── B8. THE RETURN DELIVERED TO THE PORTAL ─────────────────────────────────────────
      await page.goto('/upload-return');
      await expect(page.getByRole('heading', { name: 'Deliver a return' })).toBeVisible();
      await page.getByLabel('Find the client').fill(who.lastName);
      await page.getByLabel('Find the client').press('Enter');
      await page.getByRole('button', { name: rx(fullName) }).first().click();
      const returnFile = `HARNESS-PATHB-1040-RETURN-${viewport}.pdf`;
      await expect(page.getByLabel('Tax year')).toHaveValue(String(taxYear));
      await page.locator('input[type=file]').setInputFiles({ name: returnFile, ...PDF });
      await expect(page.getByText('Delivered — stage moved to Client Review and the client was notified.')).toBeVisible();
      await page.goto(`${PORTAL}/returns`);
      await expect(page.getByRole('heading', { name: COPY.returnsTitle })).toBeVisible();
      await expect(page.getByText(returnFile), 'the client can read the return in My Returns').toBeVisible();
      steps.push(`B8|/upload-return "Find the client" → the client's button → input[type=file] "Final return PDF (from ATX)"; read back on portal /returns|${ROLES.documents}|tap`);

      // ── B9. THE SIGNED 8879, WET-SIGNED IN OFFICE ──────────────────────────────────────
      await page.goto(clientPage);
      const uploadBtn = page.getByTestId('upload-signed-8879');
      await expect(uploadBtn).toBeVisible();
      await page.locator('input[type=file]').setInputFiles({ name: `HARNESS-PATHB-8879-SIGNED-${viewport}.pdf`, ...PDF });
      await page.getByLabel('Signed on').fill(today); // signed across the desk today
      await page.getByLabel('PTIN holder').selectOption(preparer.id);
      await uploadBtn.click();
      await expect(uploadBtn, 'the upload is the authorization; the control leaves once it is on file').toHaveCount(0);
      await expect(page.getByText('No signed authorization on file')).toHaveCount(0);
      const authorized = (await read(page, `/tax-engagements/${te}`)).taxEngagement as Record<string, unknown>;
      expect(String(authorized.f8879_signed_on ?? authorized.f8879_signed_at ?? '').slice(0, 10), 'the signed date is the date on the scan').toBe(today);
      expect(authorized.preparer_ptin_holder_id, 'the PTIN holder is recorded from the upload').toBe(preparer.id);
      steps.push(`B9|/clients/:id Returns card, input[type=file] + "Signed on" + "PTIN holder" + button "Upload the signed 8879"|${ROLES.returnControls}|tap`);

      // ── B13 (set here, issued by B10). THE FINAL FEE, inside the locked estimate ─────────
      const dialog = page.locator('[role=dialog]');
      await page.getByRole('button', { name: 'Set final fee' }).click();
      await expect(dialog).toBeVisible();
      const rangeLine = await dialog.getByText(/Quoted range:/).innerText();
      expect(rangeLine, 'the modal names the price book version the range came from').toMatch(/price book v\d+/);
      expect(rangeLine, 'and the range it reads is the estimate just locked').toContain(money(committedCents));
      const finalFeeCents = committedCents;
      await dialog.getByLabel(/Final fee/).fill((finalFeeCents / 100).toFixed(2));
      await expect(dialog.getByText('Inside the quoted range — no reason needed.')).toBeVisible();
      await expect(dialog.getByTestId('scope-creep-category'), 'the fee is the quoted scope, so no scope-creep category is asked for').toHaveCount(0);
      await dialog.getByRole('button', { name: 'Set final fee' }).click();
      await expect(dialog).toHaveCount(0);
      await expect(page.getByText(`current ${money(finalFeeCents)}`)).toBeVisible();

      // ── B10. READY TO FILE, THEN FILED WITH THE PTIN HOLDER ────────────────────────────
      await confirm(page, 'Ready to file');
      await expect(page.getByRole('button', { name: 'Ready to file' }), 'a stage already reached is not offered again').toHaveCount(0);
      await page.getByRole('button', { name: 'Mark filed' }).click();
      await expect(dialog).toBeVisible();
      await expect(dialog.getByText('No signed authorization on file')).toHaveCount(0);
      await expect(dialog.getByText(`Issues the final-fee invoice for ${money(finalFeeCents)}`)).toBeVisible();
      await dialog.getByLabel(/PTIN holder/).selectOption(preparer.id);
      await dialog.getByRole('button', { name: 'Mark filed' }).click();
      await expect(dialog).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Set final fee' }), 'the controls leave with the filing').toHaveCount(0);
      const filed = (await read(page, `/tax-engagements/${te}`)).taxEngagement as Record<string, unknown>;
      expect(filed.stage).toBe('filed');
      expect(filed.preparer_ptin_holder_id, 'the paid preparer of record is on the filing').toBe(preparer.id);
      steps.push(`B10|/clients/:id Returns card, button "Ready to file" then "Mark filed" (modal: PTIN holder)|${ROLES.returnControls}|tap`);

      /*
       * ── B13. THE FINAL INVOICE, issued by the filing through the money door ─────────────
       *
       * And the paid deposit is CREDITED against it (finding #26): what the client owes is the
       * fee minus what they already paid at B3, which is the number B14 settles.
       */
      const invoices = (await read(page, `/invoices?contactId=${who.contactId}`)).invoices as Array<Record<string, unknown>>;
      const deposit = invoices.find((i) => i.id === depositInvoiceId)!;
      const finalInvoice = invoices.find((i) => i.id !== depositInvoiceId);
      expect(finalInvoice, 'the filing issued the final-fee invoice').toBeTruthy();
      expect(['sent', 'draft'], 'issued, so the client can pay it').toContain(String(finalInvoice!.status));
      const owedCents = finalFeeCents - Number(deposit.total_cents);
      expect(finalInvoice!.total_cents, 'the deposit the client already paid is credited against the fee').toBe(owedCents);
      await page.reload();
      await expect(page.getByRole('heading', { name: /Invoices \(/ })).toBeVisible();
      await expect(page.getByText(rx(money(owedCents))).first(), 'the Invoices card shows what is owed').toBeVisible();
      steps.push(`B13|/clients/:id Returns card, "Set final fee" (modal: Final fee + Reason) then "Mark filed" issues it; the Invoices card shows it with the paid deposit credited|${ROLES.returnControls}|tap`);

      // ── B11. THE ACKNOWLEDGMENT REPORT, uploaded and released ──────────────────────────
      // A 1040's entity name is the person's, and the taxpayer-id column carries the SSN last four.
      const ackFile = `HARNESS-ATX-ACK-1040-${viewport}.csv`;
      const report = [
        'Entity Name,EIN,Tax Year,Return Type,Agency,Status,Submission ID,Ack Date,Reject Code,Reject Reason',
        `"${fullName}",${who.ssnLast4},${taxYear},1040,Federal,Accepted,H-PB-FED-${viewport},${usDate(today)},,`,
        `"${fullName}",${who.ssnLast4},${taxYear},1040,${who.state},Accepted,H-PB-ST-${viewport},${usDate(today)},,`,
      ].join('\n');
      await page.goto('/efile-acks');
      await expect(page.getByRole('heading', { name: 'E-file acknowledgments' })).toBeVisible();
      await page.locator('input[type=file]').setInputFiles({ name: ackFile, mimeType: 'text/csv', buffer: Buffer.from(report) });
      await expect(page.getByRole('status')).toContainText('2 will send');
      // The upload's own message lands before the review opens; the rows are what this reads.
      await expect(page.getByRole('heading', { name: ackFile }), 'the report opened with its rows').toBeVisible();
      const rowsText = await page.evaluate(() => document.body.innerText);
      expect(rowsText, 'both rows matched the person').toContain(fullName);
      expect(rowsText, 'the federal row will send').toMatch(/Federal[\s\S]*Will send/);
      expect(rowsText, `the ${who.state} row will send`).toMatch(new RegExp(`\\b${who.state}\\b[\\s\\S]*Will send`));
      await page.getByRole('button', { name: /^Release/ }).first().click();
      await page.locator('[role=dialog]').getByRole('button', { name: /^Release 2/ }).click();
      await expect(page.getByRole('status')).toContainText('Released: 2 queued to send');
      steps.push(`B11|/efile-acks input[type=file] "Upload ATX report", the review rows, button "Release 2 to clients" + modal "Release 2"|${ROLES.efile}|tap`);

      // ── B12. THE ACCEPTANCE EMAILS LEAVE, and the rows say so ─────────────────────────
      const reportId = String(((await read(page, '/efile-acks')).reports as Array<{ id: string; filename: string }>)
        .find((r) => r.filename === ackFile)!.id);
      let sentRows = 0;
      for (let i = 0; i < 90 && sentRows < 2; i++) {
        await page.waitForTimeout(1000);
        const rows = (await read(page, `/efile-acks/${reportId}`)).rows as Array<{ disposition: string }>;
        sentRows = rows.filter((r) => r.disposition === 'sent').length;
      }
      expect(sentRows, 'two acceptance emails left').toBe(2);
      await page.reload();
      // By name, not by position: the list carries every report the suite has uploaded today.
      await page.locator('li', { hasText: ackFile }).getByRole('button', { name: 'Open' }).click();
      await expect(page.getByRole('heading', { name: ackFile })).toBeVisible();
      await expect(page.getByText('Sent', { exact: true }).first(), 'the screen reads sent').toBeVisible();
      await page.screenshot({ path: shot, fullPage: true });
      const acked = (await read(page, `/tax-engagements/${te}`)).taxEngagement as Record<string, unknown>;
      expect(acked.state_accepted_code, 'the state the return files in accepted it').toBe(who.state);
      expect(acked.stage, 'federal and the state both accepted complete the return').toBe('completed');
      steps.push(`B12|/efile-acks reopened from the list (button "Open"), both rows reading Sent|${ROLES.efile}|tap`);

      // ── B14. THE FINAL INVOICE PAID ───────────────────────────────────────────────────
      await signInPortal(page, who.portalMagicTokens[1]!);
      const paidId = await payTap();
      expect(paidId, 'the invoice the client paid is the final-fee invoice').toBe(String(finalInvoice!.id));
      await payEvent(paidId, 'final');
      const afterPay = ((await read(page, `/invoices?contactId=${who.contactId}`)).invoices as Array<Record<string, unknown>>)
        .find((i) => i.id === finalInvoice!.id)!;
      expect(afterPay.status, 'paid').toBe('paid');
      const receipt = (afterPay.notices as Array<{ kind: string; state: string }> | undefined)?.find((n) => n.kind === 'payment_receipt');
      expect(receipt?.state, 'the payment receipt left').toBe('delivered');
      steps.push(`B14|portal /invoices button "${COPY.pay}" on the final-fee invoice → the Checkout URL the stub adapter returns (intercepted)|${ROLES.client}|tap`);
      steps.push('B14|the checkout.session.completed event posted to /webhooks/stripe with the harness webhook secret|client (card)|api');

      // ── B15. THE COMPLETED ENGAGEMENT ─────────────────────────────────────────────────
      await page.goto(clientPage);
      await expect(page.getByRole('heading', { name: /Documents \(/ })).toBeVisible();
      await page.waitForTimeout(1500);
      const done = await page.evaluate(() => document.body.innerText);
      expect(done, 'the return reads completed').toMatch(/completed/i);
      expect(done, 'the delivered return is on the record').toContain(returnFile);
      expect(done, 'the client\'s own upload is on the record').toContain(clientDoc);
      expect(done, 'the invoice reads paid').toMatch(/Paid/);
      expect(done, 'nothing on the page is a raw ISO timestamp').not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
      await expect(page.getByTestId('engagement-open-balance'), 'the open balance is gone once paid').toHaveCount(0);
      const engagements = (await read(page, `/engagements?contactId=${who.contactId}`)).engagements as Array<Record<string, unknown>>;
      const tax = engagements.find((e) => e.service_line === 'tax')!;
      expect(tax.status, 'every return filed and accepted closes the engagement').toBe('completed');
      steps.push(`B15|/clients/:id read at ${viewport}: the return completed, the return and the client's upload on file, the invoice Paid, the engagement completed with no open balance|${ROLES.quote}|tap`);
      passed = true;
    } finally {
      if (!existsSync(shot)) await page.screenshot({ path: shot, fullPage: true }).catch(() => undefined);
      testInfo.annotations.push({ type: 'screenshot', description: keepScreenshot(`path-b-${viewport}`, passed, shot) });
      for (const s of steps) testInfo.annotations.push({ type: 'walk-step', description: s });
      for (const d of defects) testInfo.annotations.push({ type: 'defect', description: d });
    }
  });
});
