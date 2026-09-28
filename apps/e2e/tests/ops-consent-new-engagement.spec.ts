/*
 * THE §7216 CONSENT FOR A NEW ENGAGEMENT (Brian, 2026-09-27, R87, with R79) — path B, steps B3c and
 * B3d, at 390 × 844 and 1280 × 800. Brian's own shape: a returning client whose Master is signed and
 * who answered the §7216 USE consent for an earlier tax engagement (the fixture's, one year back).
 *
 *   B3c  the CEO quotes a 1040 for the default tax year in Ops. The client's signed Schedule A has a
 *        live engagement under it, so the builder asks "adding or replacing"; the quote is for a year
 *        no live engagement covers, so it says so and "Adds to the existing agreement" is the focused
 *        answer (R79). The client accepts the emailed proposal in the portal.
 *   B3d  immediately after acceptance, the client's Home lists "Tax information consent (§7216) ·
 *        <year> Form 1040" under "Waiting for your signature"; its Sign opens /consent (not /sign),
 *        where the consent is offered and answered; /sign then reads no consent waiting, and no row
 *        there reads "Being prepared" for it.
 *
 * Rule 1 stands: a client whose Master is not yet signed is offered no consent (the conditioning
 * §7216 prohibits), so "signable the moment the engagement opens" is proven on a returning client.
 */
import { expect, test, type Page } from '@playwright/test';
import * as OTPAuth from 'otpauth';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..');
interface Persona { email: string; password: string; totpSecret: string }
interface ConsentPerson { contactId: string; fullName: string; lastName: string; firstYear: number; portalMagicTokens: string[] }
const fixtures = JSON.parse(readFileSync(resolve(here, '..', '.artifacts', 'fixtures.json'), 'utf8')) as {
  port: number;
  portalPort?: number;
  staff: Persona;
  consentNew: { phone: ConsentPerson; desk: ConsentPerson; item: { code: string; name: string } };
};
const API = `http://127.0.0.1:${fixtures.port}`;
const PORTAL = `http://localhost:${fixtures.portalPort ?? 3106}`;
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
const rx = (s: string) => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

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
async function quoteLinksSoFar(): Promise<string[]> {
  return ((await (await fetch(`${API}/harness/mail-links`)).json()) as { quoteLinks: string[] }).quoteLinks;
}
function keepScreenshot(name: string, passed: boolean, file: string): string {
  const dir = passed ? resolve(here, '..', '.artifacts', today) : resolve(root, 'tasks', 'walks', today);
  mkdirSync(dir, { recursive: true });
  const target = resolve(dir, `${name}.png`);
  if (existsSync(file)) copyFileSync(file, target);
  return target;
}

test.describe('the §7216 consent for a new engagement (R87, R79)', () => {
  test('B3c–B3d: a returning client accepts a new 1040; the consent is signable from Home the moment the engagement opens', async ({ page }, testInfo) => {
    test.setTimeout(240_000);
    const viewport = testInfo.project.name as 'phone' | 'desk';
    const who = fixtures.consentNew[viewport];
    const shot = testInfo.outputPath(`consent-new-engagement-${viewport}.png`);
    const steps: string[] = [];
    let passed = false;
    try {
      // ── B3c. THE QUOTE, WITH R79'S PROMPT, AND THE CLIENT'S ACCEPTANCE ───────────────────
      await signIn(page, fixtures.staff);
      await page.goto('/pipeline');
      await page.waitForLoadState('networkidle');
      await page.getByRole('button', { name: 'New quote' }).click();
      await page.getByPlaceholder('Search by name, email, or phone').fill(who.lastName);
      const chip = page.getByTestId('client-chip').filter({ hasText: who.fullName });
      await expect(chip).toBeVisible();
      await chip.click();
      await page.getByPlaceholder('Filter by name, form number or group').fill(fixtures.consentNew.item.name);
      const row = page.locator('.qb-row', { hasText: rx(fixtures.consentNew.item.name) }).first();
      await expect(row).toBeVisible();
      await row.getByRole('button', { name: /^Add / }).click();
      const linksBefore = (await quoteLinksSoFar()).length;
      await page.getByRole('button', { name: 'Create and send' }).click();
      // R79: Schedule A has a live engagement under it (the earlier year), so the builder asks; the
      // quote is for another year, so it says so and focuses "Adds to the existing agreement".
      await expect(page.getByTestId('coverage-different-year')).toContainText(`the live engagement covers ${who.firstYear}`);
      await expect(page.getByTestId('coverage-adds'), 'the default for a different tax year').toBeFocused();
      await page.getByTestId('coverage-adds').click();
      await expect(page.getByRole('heading', { name: `Quote sent to ${who.fullName}` })).toBeVisible();
      const fresh = (await quoteLinksSoFar()).slice(linksBefore);
      expect(fresh.length, 'the proposal reached the harness mailer').toBeGreaterThan(0);
      await page.locator('[role=dialog]').getByRole('button', { name: 'Dismiss' }).click();

      // The client signs in with the link they were emailed, then accepts the proposal they were emailed.
      await page.goto(`${PORTAL}/login`);
      const status = await page.evaluate(async (t) => {
        const r = await fetch('/api/portal/auth/magic/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: t }) });
        localStorage.setItem('saos_portal_authed', '1');
        return r.status;
      }, who.portalMagicTokens[0]!);
      expect(status).toBe(200);
      await page.goto(fresh[fresh.length - 1]!);
      await expect(page.getByRole('heading', { name: 'Your proposal' })).toBeVisible();
      await page.getByRole('button', { name: 'Accept and start the work' }).click();
      await expect(page.getByRole('heading', { name: 'You’re all set' })).toBeVisible();
      steps.push(`B3c|/pipeline "New quote" → the client's chip → the 1040 base line's "Add" → "Create and send" → the coverage prompt (data-testid coverage-different-year "the live engagement covers <year>"; data-testid coverage-adds "Adds to the existing agreement" focused, R79) → sent; portal /quote/:token (the emailed link) "Accept and start the work"|ceo; the client|tap`);

      // ── B3d. THE CONSENT, SIGNABLE FROM HOME THE MOMENT THE ENGAGEMENT OPENED ──────────────
      await page.goto(`${PORTAL}/`);
      await page.waitForLoadState('networkidle');
      const consentRow = page.locator('[data-testid=unsigned-row][data-kind=consent]');
      await expect(consentRow, 'listed under Waiting for your signature, naming the new engagement').toContainText(/Tax information consent \(§7216\) · \d{4} Form 1040/);
      await consentRow.getByTestId('consent-sign').click();
      await expect(page, 'a consent is answered on /consent, never /sign').toHaveURL(/\/consent$/);
      await expect(page.getByRole('button', { name: 'No, thank you' }), 'offered: signable now').toBeVisible();
      await page.getByRole('button', { name: 'Yes, you have my permission' }).click();
      await expect(page.getByRole('heading', { name: 'Permission given. You can withdraw it any time.' })).toBeVisible();
      await page.goto(`${PORTAL}/sign`);
      await page.waitForLoadState('networkidle');
      await expect(page.locator('[data-testid=envelope-row][data-status=consent-waiting]'), 'nothing waits once answered').toHaveCount(0);
      await expect(page.getByTestId('envelope-row').filter({ hasText: /§7216/ }), 'and no consent row reads "Being prepared"').toHaveCount(0);
      await page.goto(`${PORTAL}/`);
      await page.waitForLoadState('networkidle');
      await expect(page.locator('[data-testid=unsigned-row][data-kind=consent]'), 'Home stops asking').toHaveCount(0);
      await page.screenshot({ path: shot, fullPage: true });
      steps.push(`B3d|portal / (right after acceptance): row [data-testid=unsigned-row][data-kind=consent] "Tax information consent (§7216) · <year> Form 1040" → its "Sign" (data-testid consent-sign) opens /consent → "Yes, you have my permission" → "Permission given…"; /sign then has no consent row waiting and none reading "Being prepared"; Home stops asking|the client|tap`);
      passed = true;
    } finally {
      if (!existsSync(shot)) await page.screenshot({ path: shot, fullPage: true }).catch(() => undefined);
      testInfo.annotations.push({ type: passed ? 'artifact' : 'failure-screenshot', description: keepScreenshot(`consent-new-engagement-${viewport}`, passed, shot) });
      for (const s of steps) testInfo.annotations.push({ type: 'walk-step', description: s });
    }
  });
});
