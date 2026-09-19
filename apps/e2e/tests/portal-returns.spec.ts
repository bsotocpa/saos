/*
 * THE 1120S DRY RUN, step 2 (Brian, 2026-09-19): the return the fixture delivered to the portal
 * is visible to the client under My Returns. The S corp owner signs in with the link they were
 * emailed (single use, so this runs once, on the first project).
 */
import { expect, test, type Page } from '@playwright/test';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..');
const fixtures = JSON.parse(readFileSync(resolve(here, '..', '.artifacts', 'fixtures.json'), 'utf8')) as {
  portalPort?: number;
  scorp: { portalMagicToken: string; markers: { returnFile: string }; taxYear: number };
};
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());

test.use({ baseURL: `http://localhost:${fixtures.portalPort ?? 3106}` });

async function signIn(page: Page): Promise<void> {
  await page.goto('/login');
  const status = await page.evaluate(async (token) => {
    const r = await fetch('/api/portal/auth/magic/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
    localStorage.setItem('saos_portal_authed', '1');
    return r.status;
  }, fixtures.scorp.portalMagicToken);
  expect(status, 'redeeming the sign-in link the owner was emailed').toBe(200);
}
function keepScreenshot(name: string, passed: boolean, file: string): string {
  const dir = passed ? resolve(here, '..', '.artifacts', today) : resolve(root, 'tasks', 'walks', today);
  mkdirSync(dir, { recursive: true });
  const target = resolve(dir, `${name}.png`);
  if (existsSync(file)) copyFileSync(file, target);
  return target;
}

test('the delivered 1120S is under My Returns for the owner', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'phone', 'the sign-in link is single use; the phone project redeems it');
  const shot = testInfo.outputPath('portal-returns-phone.png');
  let passed = false;
  try {
    await signIn(page);
    await page.goto('/returns');
    await page.waitForTimeout(1200);
    const text = await page.evaluate(() => document.body.innerText);
    expect(text, 'the delivered return is listed').toContain(fixtures.scorp.markers.returnFile);
    expect(text, 'with its year').toContain(String(fixtures.scorp.taxYear));
    expect(text, 'nothing on the page is a raw ISO timestamp').not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    await page.screenshot({ path: shot, fullPage: true });
    passed = true;
  } finally {
    if (!existsSync(shot)) await page.screenshot({ path: shot, fullPage: true }).catch(() => undefined);
    testInfo.annotations.push({ type: 'screenshot', description: keepScreenshot('portal-returns-phone', passed, shot) });
  }
});
