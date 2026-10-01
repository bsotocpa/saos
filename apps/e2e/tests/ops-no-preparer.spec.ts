/*
 * RETURNS WITH NO PREPARER ARE VISIBLE (Brian, 2026-09-30, R102) — path J, at 390 × 844 and 1280 × 800.
 *
 *   J1  the CEO's executive view shows "Returns with no preparer" with the count the API gives; the
 *       count opens /returns?preparer=none, which lists this viewport's fixture return (its stage,
 *       "open today").
 *   J2  the internal ladder, run for the day two business days after the return opened (the harness
 *       door; the box runs it daily), raises one CEO alert; the Alerts page reads it.
 *   J3  from the list to the client, "Assign preparer": the count drops by one and the return leaves
 *       the list.
 *
 * Each viewport has its own return (noPreparer.phone / noPreparer.desk): the phone assigns its own, and
 * the desk's is still unassigned when the desk runs. Counts are compared before and after, never as
 * absolutes, because other walks' records share the harness database.
 */
import { expect, test, type Page } from '@playwright/test';
import * as OTPAuth from 'otpauth';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { viewportKey } from './viewport';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..');
interface Persona { email: string; password: string; totpSecret: string }
interface NoPreparerReturn { contactId: string; taxEngagementId: string; lastName: string; taxYear: number }
const fixtures = JSON.parse(readFileSync(resolve(here, '..', '.artifacts', 'fixtures.json'), 'utf8')) as {
  port: number;
  staff: Persona;
  scorp: { preparer: { id: string; name: string } };
  noPreparer: { phone: NoPreparerReturn; desk: NoPreparerReturn };
};
const API = `http://127.0.0.1:${fixtures.port}`;
const ROLES = 'ceo (dashboards.executive; the alert goes to the CEO); engagements.tax.manage to assign';
const chicagoToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());

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
async function read(page: Page, path: string): Promise<Record<string, unknown>> {
  return page.evaluate(async (p) => (await fetch(`/api${p}`)).json().catch(() => ({})), path);
}
/** Two business days after `day` (weekends skipped; the ladder's own clock is proven in no-preparer.spec.ts). */
function twoBusinessDaysAfter(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  let left = 2;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) left--;
  }
  return d.toISOString().slice(0, 10);
}
function keepScreenshot(name: string, passed: boolean, file: string): string {
  const dir = passed ? resolve(here, '..', '.artifacts', chicagoToday()) : resolve(root, 'tasks', 'walks', chicagoToday());
  mkdirSync(dir, { recursive: true });
  const target = resolve(dir, `${name}.png`);
  if (existsSync(file)) copyFileSync(file, target);
  return target;
}

test.describe('Ops → returns with no preparer (R102)', () => {
  test('J1–J3: the executive count opens the list, the ladder alerts the CEO after two business days, assigning clears it', async ({ page }, testInfo) => {
    const viewport = viewportKey(testInfo);
    const ret = fixtures.noPreparer[viewport];
    const shot = testInfo.outputPath(`no-preparer-${viewport}.png`);
    const steps: string[] = [];
    let passed = false;
    try {
      // ── J1. THE COUNT, AND THE LIST IT OPENS ─────────────────────────────────────────────
      await signIn(page, fixtures.staff);
      await page.goto('/');
      const cardJ = page.getByTestId('no-preparer-card');
      await expect(cardJ.getByRole('heading', { name: 'Returns with no preparer' })).toBeVisible();
      const before = ((await read(page, '/dashboards/executive')).returnsWithNoPreparer as { count: number }).count;
      expect(before, 'this viewport\'s fixture return is counted').toBeGreaterThanOrEqual(1);
      const count = page.getByTestId('no-preparer-count');
      await expect(count, 'the view prints the API\'s count').toHaveText(String(before));
      await count.click();
      await expect(page).toHaveURL(/\/returns\?preparer=none$/);
      await expect(page.getByRole('heading', { name: 'Returns with no preparer' })).toBeVisible();
      const line = page.getByTestId(viewport === 'phone' ? `open-return-card-${ret.taxEngagementId}` : `open-return-row-${ret.taxEngagementId}`);
      await expect(line, 'the return is in the list').toBeVisible();
      await expect(line).toContainText(`Synthetic ${ret.lastName}`);
      await expect(line).toContainText(`1040 · ${ret.taxYear}`);
      await expect(line, 'its stage').toContainText('Intake started');
      await expect(line, 'opened today').toContainText('today');
      const listed = ((await read(page, '/dashboards/open-returns?preparer=none')).returns as unknown[]).length;
      expect(listed, 'the list holds exactly the counted returns').toBe(before);
      steps.push(`J1|/ (executive view) card "Returns with no preparer", data-testid no-preparer-count = GET /dashboards/executive returnsWithNoPreparer.count → /returns?preparer=none "Returns with no preparer": the return's row (client, 1040 · year, Intake started, open today); the list's length equals the count|${ROLES}|tap`);

      // ── J2. TWO BUSINESS DAYS LATER, THE CEO IS ALERTED ──────────────────────────────────
      const day = twoBusinessDaysAfter(chicagoToday());
      const run = await fetch(`${API}/harness/internal-ladder`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ today: day }) });
      expect(run.status).toBe(200);
      // Once per return: the phone's run alerts the desk's return too, so the desk reads the alert already raised.
      expect(((await run.json()) as { noPreparerConsidered: number }).noPreparerConsidered, 'this return is considered').toBeGreaterThanOrEqual(1);
      await page.goto('/alerts');
      await expect(page.getByRole('heading', { name: 'Alerts' })).toBeVisible();
      await expect(page.getByText(`2 business days with no preparer: ${ret.taxYear} 1040 for Synthetic ${ret.lastName}`), 'the CEO\'s alert names the return').toBeVisible();
      steps.push(`J2|the internal_task_ladder job for ${'<today + 2 business days>'} (POST /harness/internal-ladder; the box runs it daily) → /alerts "2 business days with no preparer: <year> 1040 for <client>"|${ROLES}|tap`);

      // ── J3. ASSIGNED, IT LEAVES THE COUNT AND THE LIST ───────────────────────────────────
      await page.goto('/returns?preparer=none');
      // The phone's card is itself the link; the desk's row holds one on the client's name.
      if (viewport === 'phone') await line.click();
      else await line.getByRole('link').first().click();
      await page.waitForURL(new RegExp(`/clients/${ret.contactId}$`));
      const returns = page.locator('section.card', { has: page.getByRole('heading', { name: 'Returns' }) });
      const dialog = page.locator('[role=dialog]');
      await returns.getByRole('button', { name: 'Assign preparer' }).first().click();
      await dialog.getByTestId('preparer-select').locator('select').selectOption(fixtures.scorp.preparer.id);
      await dialog.getByRole('button', { name: 'Assign preparer' }).click();
      await expect(dialog).toHaveCount(0);
      await page.goto('/');
      await expect(page.getByTestId('no-preparer-count'), 'one fewer').toHaveText(String(before - 1));
      await page.getByTestId('no-preparer-count').click();
      await expect(page.getByRole('heading', { name: 'Returns with no preparer' })).toBeVisible();
      await expect(page.getByTestId(`open-return-row-${ret.taxEngagementId}`)).toHaveCount(0);
      await expect(page.getByTestId(`open-return-card-${ret.taxEngagementId}`)).toHaveCount(0);
      steps.push(`J3|/returns?preparer=none → the client → Returns card "Assign preparer" (modal preparer select, "Assign preparer") → the executive count one lower, the return gone from the list|${ROLES}|tap`);

      await page.screenshot({ path: shot, fullPage: true });
      passed = true;
    } finally {
      if (!existsSync(shot)) await page.screenshot({ path: shot, fullPage: true }).catch(() => undefined);
      testInfo.annotations.push({ type: 'screenshot', description: keepScreenshot(`no-preparer-${viewport}`, passed, shot) });
      for (const s of steps) testInfo.annotations.push({ type: 'walk-step', description: s });
    }
  });
});
