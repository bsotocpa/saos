/*
 * THE 1120S DRY RUN (Brian, 2026-09-19): the return was filed in ATX on time, outside SAOS. The
 * fixture delivered it to the portal; from here the harness does what Brian will do live, as
 * Brian in every role, through the screens and the routes a person uses:
 *
 *   3. the signed 8879-CORP scan, with its real signed date (before the SAOS record existed) and
 *      Ana-Maria as the PTIN holder: a future date is refused, a past one authorizes; then filed;
 *   4. the ATX acknowledgment report uploaded on the E-file acks screen as the CEO, reviewed and
 *      released: the federal and Illinois rows match the entity by folded name and EIN last-4,
 *      two acceptance emails leave, and the actor on each send is the person who released;
 *   5. the final-fee invoice the filing issued, paid (the card is Brian's live step; here the
 *      same payment event Stripe sends), the receipt sent, the dashboard's money line empty
 *      because the actor is the CEO, and the engagement completed with the invoice paid.
 *
 * The flow mutates the fixture once, on the first project (the phone). Both projects then read
 * the finished state on the client page.
 */
import { expect, test, type Page } from '@playwright/test';
import * as OTPAuth from 'otpauth';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..');
const fixtures = JSON.parse(readFileSync(resolve(here, '..', '.artifacts', 'fixtures.json'), 'utf8')) as {
  staff: { email: string; password: string; totpSecret: string };
  scorp: {
    contactId: string; businessId: string; engagementId: string; taxEngagementId: string;
    markers: { business: string; document: string; returnFile: string };
    entityName: string; einLast4: string; taxYear: number; preparer: { id: string; name: string };
    finalFeeCents: number; webhookSecret: string;
  };
};
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());

async function signIn(page: Page): Promise<void> {
  const code = new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(fixtures.staff.totpSecret) }).generate();
  await page.goto('/login');
  const status = await page.evaluate(async ({ email, password, totp }) => {
    const r = await fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password, totp }) });
    sessionStorage.setItem('saos_staff_authed', '1');
    return r.status;
  }, { email: fixtures.staff.email, password: fixtures.staff.password, totp: code });
  expect(status, 'the staff login').toBe(200);
}
async function call(page: Page, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: Record<string, unknown> }> {
  return page.evaluate(async ({ method, p, body, headers }) => {
    const r = await fetch(`/api${p}`, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  }, { method, p: path, body, headers });
}
/** A staff upload, the way the Ops pages do it: multipart through the browser's own fetch. */
async function upload(page: Page, fields: Record<string, string>, file: { name: string; type: string; text: string }): Promise<{ status: number; json: Record<string, unknown> }> {
  return page.evaluate(async ({ fields, file, p }) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.append(k, v);
    fd.append('file', new File([file.text], file.name, { type: file.type }), file.name);
    const r = await fetch(`/api${p}`, { method: 'POST', body: fd });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  }, { fields, file, p: '/documents' });
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

test.describe('The 1120S dry run', () => {
  test('signed 8879-CORP, filed, acknowledged on the acks screen, paid, completed', async ({ page }, testInfo) => {
    // The flow runs once, on the first project; the second project reads the finished state below.
    test.skip(testInfo.project.name !== 'phone', 'the flow mutates the fixture once; the desk project reads the result');
    test.setTimeout(240_000); // five steps and a wait on the outbox sweep
    const shot = testInfo.outputPath('scorp-dry-run-acks.png');
    let passed = false;
    try {
      await signIn(page);
      const te = fixtures.scorp.taxEngagementId;

      // 3. THE SIGNED 8879-CORP. A future date is refused; the real, past date authorizes the return.
      const tooLate = await upload(page, { contactId: fixtures.scorp.contactId, category: 'signed_authorizations', taxEngagementId: te, signedOn: plusDays(2), preparerPtinHolderId: fixtures.scorp.preparer.id }, { name: 'HARNESS-8879-CORP-FUTURE.pdf', type: 'application/pdf', text: '%PDF-1.4 synthetic 8879-CORP\n%%EOF' });
      expect(tooLate.status, 'a signed date after today is refused').toBe(409);
      expect(tooLate.json.error).toBe('signed_date_in_future');
      const signedOn = '2026-09-10';
      const signed = await upload(page, { contactId: fixtures.scorp.contactId, category: 'signed_authorizations', taxEngagementId: te, signedOn, preparerPtinHolderId: fixtures.scorp.preparer.id }, { name: 'HARNESS-8879-CORP-SIGNED.pdf', type: 'application/pdf', text: '%PDF-1.4 synthetic 8879-CORP\n%%EOF' });
      expect(signed.status, `the signed scan: ${JSON.stringify(signed.json)}`).toBe(201);
      expect(signed.json.signed8879, 'the upload is the authorization').toBe(true);
      const afterSign = await call(page, 'GET', `/tax-engagements/${te}`);
      const rec = afterSign.json.taxEngagement as Record<string, unknown>;
      expect(String(rec.f8879_signed_on ?? rec.f8879_signed_at ?? '').slice(0, 10), 'the signed date is the date on the scan').toBe(signedOn);

      // The final fee, then filed: the filing issues the invoice.
      const fee = await call(page, 'POST', `/tax-engagements/${te}/final-fee`, { finalFeeCents: fixtures.scorp.finalFeeCents });
      expect(fee.status, JSON.stringify(fee.json)).toBe(200);
      const toReady = await call(page, 'POST', `/tax-engagements/${te}/transition`, { toStage: 'ready_to_file' });
      expect(toReady.status, JSON.stringify(toReady.json)).toBe(200);
      const filed = await call(page, 'POST', `/tax-engagements/${te}/transition`, { toStage: 'filed', preparerPtinHolderId: fixtures.scorp.preparer.id });
      expect(filed.status, `filed: ${JSON.stringify(filed.json)}`).toBe(200);
      const invoices = await call(page, 'GET', `/invoices?contactId=${fixtures.scorp.contactId}`);
      const inv = (invoices.json.invoices as Array<Record<string, unknown>>).find((i) => i.status === 'sent' || i.status === 'draft');
      expect(inv, 'the filing issued the final-fee invoice').toBeTruthy();
      expect(inv!.total_cents, 'at the nominal amount').toBe(fixtures.scorp.finalFeeCents);

      // 4. THE ATX ACKNOWLEDGMENT REPORT, on the E-file acks screen, as the CEO.
      const report = [
        'Entity Name,EIN,Tax Year,Return Type,Agency,Status,Submission ID,Ack Date,Reject Code,Reject Reason',
        `"${fixtures.scorp.entityName}",${fixtures.scorp.einLast4},${fixtures.scorp.taxYear},1120S,Federal,Accepted,H-FED-1,${today.slice(5, 7)}/${today.slice(8, 10)}/${today.slice(0, 4)},,`,
        `"${fixtures.scorp.entityName}",${fixtures.scorp.einLast4},${fixtures.scorp.taxYear},1120S,IL,Accepted,H-IL-1,${today.slice(5, 7)}/${today.slice(8, 10)}/${today.slice(0, 4)},,`,
      ].join('\n');
      await page.goto('/efile-acks');
      await expect(page.getByRole('heading', { name: 'E-file acknowledgments' })).toBeVisible();
      await page.locator('input[type=file]').setInputFiles({ name: 'HARNESS-ATX-ACK-1120S.csv', mimeType: 'text/csv', buffer: Buffer.from(report) });
      await expect(page.getByRole('status')).toContainText('2 will send');
      await expect(page.getByText(fixtures.scorp.markers.business).first(), 'the report opened with its rows').toBeVisible();
      let text = await page.evaluate(() => document.body.innerText);
      expect(text, 'both rows matched the entity').toContain(fixtures.scorp.markers.business);
      expect(text, 'the federal row will send').toMatch(/Federal[\s\S]*Will send/);
      expect(text, 'the Illinois row will send').toMatch(/\bIL\b[\s\S]*Will send/);
      await page.getByRole('button', { name: /^Release/ }).first().click();
      await page.locator('[role=dialog]').getByRole('button', { name: /^Release 2/ }).click();
      await expect(page.getByRole('status')).toContainText('Released: 2 queued to send');
      // The harness API drains the outbox every two seconds; the rows say sent when it has.
      let sent = 0;
      for (let i = 0; i < 90 && sent < 2; i++) {
        await page.waitForTimeout(1000);
        const view = await call(page, 'GET', `/efile-acks`);
        const rep = (view.json.reports as Array<{ id: string }>)[0];
        const rows = ((await call(page, 'GET', `/efile-acks/${rep.id}`)).json.rows as Array<{ disposition: string }>);
        sent = rows.filter((r) => r.disposition === 'sent').length;
      }
      expect(sent, 'two acceptance emails left').toBe(2);
      // The screen, reopened the way a person would after the sweep: the report from the list, its rows reading Sent.
      await page.reload();
      await page.getByRole('button', { name: 'Open' }).first().click();
      await expect(page.getByText('Sent', { exact: true }).first(), 'the screen reads sent').toBeVisible();
      await page.screenshot({ path: shot, fullPage: true });
      const afterAck = await call(page, 'GET', `/tax-engagements/${te}`);
      const acked = afterAck.json.taxEngagement as Record<string, unknown>;
      expect(acked.stage, 'the federal acceptance completes the return').toBe('completed');
      expect(acked.state_accepted_code, 'Illinois accepted beside it').toBe('IL');
      const engagement = (((await call(page, 'GET', `/engagements?contactId=${fixtures.scorp.contactId}`)).json.engagements) as Array<Record<string, unknown>>).find((e) => e.id === fixtures.scorp.engagementId)!;
      expect(engagement.status, 'every return filed and accepted closes the engagement').toBe('completed');

      // The money line before the payment: whatever the fixture's webhook refunds put there (system actor).
      const moneyBefore = ((await call(page, 'GET', '/dashboards/executive')).json.moneyActionsToday) as Array<{ actor: string }>;

      // 5. THE PAYMENT: the event Stripe sends when the card clears (Brian's live step is the card).
      const paid = await call(page, 'POST', '/webhooks/stripe', { id: 'evt_harness_scorp_paid', type: 'checkout.session.completed', data: { object: { id: `cs_harness_${inv!.id}`, payment_intent: 'pi_harness_scorp', metadata: { invoice_id: inv!.id } } } }, { 'x-webhook-secret': fixtures.scorp.webhookSecret });
      expect(paid.status, `payment: ${JSON.stringify(paid.json)}`).toBeLessThan(300);
      const afterPay = (((await call(page, 'GET', `/invoices?contactId=${fixtures.scorp.contactId}`)).json.invoices) as Array<Record<string, unknown>>).find((i) => i.id === inv!.id)!;
      expect(afterPay.status, 'paid').toBe('paid');
      const receipt = (afterPay.notices as Array<{ kind: string; state: string }> | undefined)?.find((n) => n.kind === 'payment_receipt');
      expect(receipt?.state, 'the payment receipt left').toBe('delivered');

      // The dashboard's money line: nothing new, because the actor on every step was the CEO. (What is
      // there came from the fixture's webhook refunds, whose actor is the system, not a person.)
      const moneyAfter = ((await call(page, 'GET', '/dashboards/executive')).json.moneyActionsToday) as Array<{ actor: string }>;
      expect(moneyAfter.length, 'the payment and the completion added no money action').toBe(moneyBefore.length);
      expect(moneyAfter.some((m) => /Walker/.test(m.actor)), 'none of it is the CEO').toBe(false);
      await page.goto('/');
      await expect(page.getByTestId('money-actions-today')).toContainText(`Money actions today by staff: ${moneyAfter.length}`);
      passed = true;
    } finally {
      if (!existsSync(shot)) await page.screenshot({ path: shot, fullPage: true }).catch(() => undefined);
      testInfo.annotations.push({ type: 'screenshot', description: keepScreenshot('scorp-dry-run-acks', passed, shot) });
    }
  });

  test('the client page reads the finished run: filed and accepted, the return delivered, the invoice paid, the engagement completed', async ({ page }, testInfo) => {
    const viewport = testInfo.project.name;
    const shot = testInfo.outputPath(`scorp-done-${viewport}.png`);
    let passed = false;
    try {
      await signIn(page);
      await page.goto(`/clients/${fixtures.scorp.contactId}`);
      await expect(page.getByRole('heading', { name: /Documents \(/ })).toBeVisible();
      await page.waitForTimeout(1500);
      const text = await page.evaluate(() => document.body.innerText);
      expect(text).toContain(fixtures.scorp.markers.returnFile);
      expect(text, 'the return reads completed').toMatch(/completed/i);
      expect(text, 'the invoice reads paid').toMatch(/Paid/);
      expect(text, 'no period badge on a completed business return is a lie either way; the year is on the return').not.toMatch(/period not recorded/);
      expect(text, 'nothing on the page is a raw ISO timestamp').not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
      await page.screenshot({ path: shot, fullPage: true });
      passed = true;
    } finally {
      if (!existsSync(shot)) await page.screenshot({ path: shot, fullPage: true }).catch(() => undefined);
      testInfo.annotations.push({ type: 'screenshot', description: keepScreenshot(`scorp-done-${viewport}`, passed, shot) });
    }
  });
});
