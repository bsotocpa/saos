/*
 * THE 1120S DRY RUN (Brian, 2026-09-19): the return was filed in ATX on time, outside SAOS. The
 * fixture delivered it to the portal; from here the harness does what Brian will do live, through
 * the screens a person taps (ruling 2026-09-19, BUILD 3: no API-driven step), at 390 and 1280:
 *
 *   6. the signed 8879-CORP scan from the return's row on the client page, with its real signed
 *      date (before the SAOS record existed) and Ana-Maria as the PTIN holder: a future date is
 *      refused beside the date control, a past one authorizes;
 *   7. the final fee from the same row: outside the quoted range it is refused in the modal until a
 *      reason is given; then Ready to file, then Mark filed with the PTIN holder, which issues the
 *      final-fee invoice through the money door;
 *   8. the ATX acknowledgment report uploaded on the E-file acks screen, reviewed and released;
 *   9. both rows read Sent; two acceptance emails left, and the return is completed only once the
 *      federal and the Illinois rows are both accepted;
 *  10. the final-fee invoice paid (the card is Brian's live step; here the same payment event
 *      Stripe sends, which is an API call and is reported as such);
 *  11. the receipt, the money line, the completed engagement with its open balance gone.
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
const fixtures = JSON.parse(readFileSync(resolve(here, '..', '.artifacts', 'fixtures.json'), 'utf8')) as {
  staff: Persona;
  wall: { jaqueline: Persona };
  scorp: Scorp; scorpDesk: Scorp;
};
interface Scorp {
  contactId: string; businessId: string; engagementId: string; taxEngagementId: string;
  markers: { business: string; document: string; returnFile: string };
  entityName: string; einLast4: string; taxYear: number; preparer: { id: string; name: string };
  finalFeeCents: number; webhookSecret: string;
}
/** One S corporation per viewport: each project taps its own return from the signed 8879 to the paid invoice. */
const scorpFor = (project: string): Scorp => (project === 'desk' ? fixtures.scorpDesk : fixtures.scorp);
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
const ROLES = 'tax_preparer, ceo (engagements.tax.manage)';

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
/** A read of the API from the signed-in session, for assertions on state the screen does not print. */
async function read(page: Page, path: string): Promise<Record<string, unknown>> {
  return page.evaluate(async (p) => (await fetch(`/api${p}`)).json().catch(() => ({})), path);
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

test.describe('The 1120S dry run', () => {
  test('signed 8879-CORP, final fee, filed, acknowledged on the acks screen, paid, completed', async ({ page }, testInfo) => {
    const viewport = testInfo.project.name;
    const scorp = scorpFor(viewport);
    test.setTimeout(300_000); // six screens and a wait on the outbox sweep
    const shot = testInfo.outputPath(`scorp-dry-run-acks-${viewport}.png`);
    const steps: string[] = [];
    let passed = false;
    try {
      const te = scorp.taxEngagementId;
      const clientPage = `/clients/${scorp.contactId}`;

      // ROLE PROOF: Jaqueline (ed_coo) holds engagements.read, so the return row is on her page, and no
      // engagements.tax.manage, so none of its controls are. (Laura, va_entity, sees no returns at all.)
      await signIn(page, fixtures.wall.jaqueline);
      await page.goto(clientPage);
      await expect(page.getByRole('heading', { name: 'Returns' })).toBeVisible();
      await expect(page.getByText(/1120S/).first(), 'the return row is on her page').toBeVisible();
      await page.waitForTimeout(800);
      for (const name of ['Set final fee', 'Lock estimate', 'Ready to file', 'Mark filed']) {
        await expect(page.getByRole('button', { name }), `${name} is not on Jaqueline's page`).toHaveCount(0);
      }
      await expect(page.getByTestId('upload-signed-8879')).toHaveCount(0);
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

      // 7. THE FINAL FEE against the quoted range: outside it, the modal refuses until a reason is given.
      await page.getByRole('button', { name: 'Set final fee' }).click();
      const dialog = page.locator('[role=dialog]');
      await expect(dialog).toBeVisible();
      const rangeLine = await dialog.getByText(/Quoted range:/).innerText();
      const amounts = [...rangeLine.matchAll(/\$([\d,]+\.\d{2})/g)].map((m) => Math.round(Number(m[1].replace(/,/g, '')) * 100));
      expect(amounts.length, `the modal names the quoted range and the price book version: ${rangeLine}`).toBeGreaterThan(0);
      expect(rangeLine).toMatch(/price book v\d+/);
      const finalFeeCents = amounts[amounts.length - 1]! + 10_000; // one hundred dollars above the top of the range
      await dialog.getByLabel(/Final fee/).fill((finalFeeCents / 100).toFixed(2));
      await expect(dialog.getByText('Outside the quoted range')).toBeVisible();
      await dialog.getByRole('button', { name: 'Set final fee' }).click();
      await expect(dialog.locator('#ask-error'), 'refused in the modal, in the server\'s words').toContainText('is outside the quoted range');
      await expect(dialog.getByLabel(/Final fee/), 'the amount stays').toHaveValue((finalFeeCents / 100).toFixed(2));
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
      await expect(dialog.getByLabel(/PTIN holder/), 'the PTIN holder defaults to the assigned preparer').toHaveValue(scorp.preparer.id);
      await expect(dialog.getByText(`Issues the final-fee invoice for ${money(finalFeeCents)}`)).toBeVisible();
      await dialog.getByRole('button', { name: 'Mark filed' }).click();
      await expect(dialog).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Set final fee' }), 'the controls leave with the filing').toHaveCount(0);
      const invoices = (await read(page, `/invoices?contactId=${scorp.contactId}`)).invoices as Array<Record<string, unknown>>;
      const inv = invoices.find((i) => i.total_cents === finalFeeCents);
      expect(inv, 'the filing issued the final-fee invoice at the fee set on the row').toBeTruthy();
      expect(['sent', 'draft']).toContain(inv!.status);
      steps.push(`A7|/clients/:id Returns card, buttons "Set final fee" (modal: Final fee, Reason), "Ready to file", "Mark filed" (modal: PTIN holder)|${ROLES}|tap`);

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
      let sent = 0;
      for (let i = 0; i < 90 && sent < 2; i++) {
        await page.waitForTimeout(1000);
        const view = await read(page, '/efile-acks');
        const rep = (view.reports as Array<{ id: string }>)[0];
        const rows = (await read(page, `/efile-acks/${rep.id}`)).rows as Array<{ disposition: string }>;
        sent = rows.filter((r) => r.disposition === 'sent').length;
      }
      expect(sent, 'two acceptance emails left').toBe(2);
      // The screen, reopened the way a person would after the sweep: the report from the list, its rows reading Sent.
      await page.reload();
      await page.getByRole('button', { name: 'Open' }).first().click();
      await expect(page.getByText('Sent', { exact: true }).first(), 'the screen reads sent').toBeVisible();
      await page.screenshot({ path: shot, fullPage: true });
      const acked = (await read(page, `/tax-engagements/${te}`)).taxEngagement as Record<string, unknown>;
      expect(acked.stage, 'federal and Illinois both accepted complete the return').toBe('completed');
      expect(acked.state_accepted_code, 'Illinois accepted beside it').toBe('IL');
      const engagement = ((await read(page, `/engagements?contactId=${scorp.contactId}`)).engagements as Array<Record<string, unknown>>).find((e) => e.id === scorp.engagementId)!;
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

      // 10. THE PAYMENT: the event Stripe sends when the card clears (Brian's live step is the card; this is an API call).
      const paid = await page.evaluate(async ({ id, secret, vp }) => {
        const r = await fetch('/api/webhooks/stripe', { method: 'POST', headers: { 'content-type': 'application/json', 'x-webhook-secret': secret }, body: JSON.stringify({ id: `evt_harness_scorp_paid_${vp}`, type: 'checkout.session.completed', data: { object: { id: `cs_harness_${id}`, payment_intent: 'pi_harness_scorp', metadata: { invoice_id: id } } } }) });
        return r.status;
      }, { id: String(inv!.id), secret: scorp.webhookSecret, vp: viewport });
      expect(paid, 'the payment event').toBeLessThan(300);
      const afterPay = ((await read(page, `/invoices?contactId=${scorp.contactId}`)).invoices as Array<Record<string, unknown>>).find((i) => i.id === inv!.id)!;
      expect(afterPay.status, 'paid').toBe('paid');
      const receipt = (afterPay.notices as Array<{ kind: string; state: string }> | undefined)?.find((n) => n.kind === 'payment_receipt');
      expect(receipt?.state, 'the payment receipt left').toBe('delivered');
      steps.push('A10|Stripe Checkout is outside SAOS; the harness posts the checkout.session.completed event to /webhooks/stripe|client (card)|api');

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
      expect(text).toContain(scorp.markers.returnFile);
      expect(text, 'the return reads completed').toMatch(/completed/i);
      expect(text, 'the invoice reads paid').toMatch(/Paid/);
      expect(text, 'no open balance once paid').not.toMatch(/Open balance/);
      expect(text, 'no period badge on a completed business return is a lie either way; the year is on the return').not.toMatch(/period not recorded/);
      expect(text, 'nothing on the page is a raw ISO timestamp').not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
      await page.screenshot({ path: shot, fullPage: true });
      passed = true;
    } finally {
      if (!existsSync(shot)) await page.screenshot({ path: shot, fullPage: true }).catch(() => undefined);
      testInfo.annotations.push({ type: 'screenshot', description: keepScreenshot(`scorp-done-${viewport}`, passed, shot) });
      testInfo.annotations.push({ type: 'walk-step', description: `A11|/clients/:id read at ${viewport}: return completed, invoice paid, engagement completed, no open balance|ceo|tap` });
    }
  });
});
