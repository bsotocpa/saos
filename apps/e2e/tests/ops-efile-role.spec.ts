/*
 * WHO HOLDS THE E-FILE ACKS SCREEN (Brian, 2026-09-19 evening, R3). efile.manage is the permission
 * the six /efile-acks routes require, and the tax preparer holds it: Ana-Maria opens the page at 390
 * and 1280 and the upload control is there. The bookkeeper does not hold it, so the same page gives
 * her no upload control and GET /efile-acks refuses her.
 *
 * NO REPORT IS UPLOADED HERE. This spec proves the door, not the flow — the S corp dry run owns the
 * acknowledgment flow itself, and two specs uploading reports into one harness database would make
 * each one's row counts depend on the other's order.
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
  wall: { anamaria: Persona; bookkeeper: Persona };
};
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
const ROLES = 'tax_preparer, ceo (efile.manage)';

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
function keepScreenshot(name: string, passed: boolean, file: string): string {
  const dir = passed ? resolve(here, '..', '.artifacts', today) : resolve(root, 'tasks', 'walks', today);
  mkdirSync(dir, { recursive: true });
  const target = resolve(dir, `${name}.png`);
  if (existsSync(file)) copyFileSync(file, target);
  return target;
}

test.describe('E-file acks, by role', () => {
  test('the tax preparer opens the page and the upload control is there; the bookkeeper gets neither the control nor the list', async ({ page }, testInfo) => {
    const viewport = testInfo.project.name;
    const shot = testInfo.outputPath(`efile-role-${viewport}.png`);
    let passed = false;
    try {
      // Ana-Maria (tax_preparer): the nav entry, the heading, the upload control.
      await signIn(page, fixtures.wall.anamaria);
      await page.goto('/efile-acks');
      await expect(page.getByRole('link', { name: 'E-file acks' }), 'the page is in her navigation').toBeVisible();
      await expect(page.getByRole('heading', { name: 'E-file acknowledgments' })).toBeVisible();
      await expect(page.getByText('Upload ATX report'), 'the preparer has the upload control').toBeVisible();
      const preparerList = await page.evaluate(async () => (await fetch('/api/efile-acks')).status);
      expect(preparerList, 'and the route answers her').toBe(200);
      const pageText = await page.evaluate(() => document.body.innerText);
      expect(pageText, 'no refusal on her screen').not.toMatch(/does not hold/);
      await page.screenshot({ path: shot, fullPage: true });

      // The bookkeeper: the same URL, no upload control, and the route refuses her.
      await signIn(page, fixtures.wall.bookkeeper);
      await page.goto('/efile-acks');
      await expect(page.getByRole('heading', { name: 'E-file acknowledgments' }), 'the page still renders').toBeVisible();
      await expect(page.getByText('Upload ATX report'), 'the control is not on her page').toHaveCount(0);
      const status = await page.evaluate(async () => (await fetch('/api/efile-acks')).status);
      expect(status, 'the route refuses a role without efile.manage').toBe(403);
      await expect(page.locator('.alert.error'), 'and she is told why, not left with an empty list').toContainText('efile.manage');
      passed = true;
    } finally {
      if (!existsSync(shot)) await page.screenshot({ path: shot, fullPage: true }).catch(() => undefined);
      testInfo.annotations.push({ type: 'screenshot', description: keepScreenshot(`efile-role-${viewport}`, passed, shot) });
      testInfo.annotations.push({ type: 'walk-step', description: `A8|role proof: bookkeeper has no upload control and GET /efile-acks is 403; tax_preparer sees the control|${ROLES}|tap` });
    }
  });
});
