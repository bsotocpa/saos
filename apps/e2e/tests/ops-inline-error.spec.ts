/*
 * A FORM ERROR RENDERS AT THE CONTROL THAT CAUSED IT (Brian, 2026-09-19, defect 2). On the walk,
 * "Rehearsal client." was refused and the refusal read "request failed" at the top of the page,
 * with the typed text gone. Here, at 390px, the harness types a chat artifact into "Amend reason",
 * reads the server's own words beside the field, and finds the text still there.
 */
import { expect, test, type Page } from '@playwright/test';
import * as OTPAuth from 'otpauth';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..');
const fixtures = JSON.parse(readFileSync(resolve(here, '..', '.artifacts', 'fixtures.json'), 'utf8')) as {
  contactId: string;
  staff: { email: string; password: string; totpSecret: string };
  amend: { invoiceId: string };
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
function keepScreenshot(name: string, passed: boolean, file: string): string {
  const dir = passed ? resolve(here, '..', '.artifacts', today) : resolve(root, 'tasks', 'walks', today);
  mkdirSync(dir, { recursive: true });
  const target = resolve(dir, `${name}.png`);
  if (existsSync(file)) copyFileSync(file, target);
  return target;
}

test('a refused amend shows the server\'s words beside the field, and the field keeps the text', async ({ page }, testInfo) => {
  const viewport = testInfo.project.name;
  const shot = testInfo.outputPath(`inline-error-${viewport}.png`);
  let passed = false;
  try {
    await signIn(page);
    await page.goto(`/clients/${fixtures.contactId}`);
    await expect(page.getByRole('heading', { name: /Invoices \(/ })).toBeVisible();
    await page.getByRole('button', { name: 'Amend reason' }).first().click();
    const dialog = page.locator('[role=dialog]');
    await expect(dialog).toBeVisible();
    const typed = 'per ruling 3, the check is fine';
    await dialog.locator('textarea').fill(typed);
    await dialog.getByRole('button', { name: 'Add the amendment' }).click();

    // The refusal, verbatim, beside the field; the modal still open; the text still there.
    const error = dialog.locator('.field-error');
    await expect(error).toBeVisible();
    await expect(error).toContainText('a ruling number points into a conversation');
    await expect(dialog.locator('textarea')).toHaveValue(typed);
    const pageText = await page.evaluate(() => document.body.innerText);
    expect(pageText, 'nothing reads "request failed"').not.toMatch(/request failed/i);
    // Defect 4, the same walk: the harness client's bookkeeping engagement carries no period badge and no set-period control.
    expect(pageText, 'no period badge on a bookkeeping line').not.toMatch(/period not recorded/);
    // And the error sits within the field's own box, not at the page top.
    const fieldBox = await dialog.locator('textarea').boundingBox();
    const errBox = await error.boundingBox();
    expect(errBox && fieldBox && errBox.y >= fieldBox.y, 'the error is at or below the field').toBeTruthy();
    expect(errBox && fieldBox && errBox.y - (fieldBox.y + fieldBox.height) < 80, 'the error is right under it').toBeTruthy();

    await page.screenshot({ path: shot, fullPage: false });
    passed = true;
  } finally {
    if (!existsSync(shot)) await page.screenshot({ path: shot, fullPage: false }).catch(() => undefined);
    testInfo.annotations.push({ type: 'screenshot', description: keepScreenshot(`inline-error-${viewport}`, passed, shot) });
  }
});
