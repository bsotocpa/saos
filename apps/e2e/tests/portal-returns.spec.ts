/*
 * WALK STEP A5 (Brian, 2026-09-19): the return the walk delivered to the portal is visible to the
 * client under My Returns. The owner signs in with a link they were emailed — single use, so each
 * viewport redeems its own: the fixture mints three per owner (the throttle's whole budget) and
 * this one takes the second, the dry run having taken the first.
 *
 * BOTH PROJECTS (2026-09-19 evening, BUILD 1). This used to skip everything but the phone, so A5
 * was cleared at 390 and unproven at 1280. Each viewport has its own S corporation and its own
 * owner, so there is nothing to share and nothing to skip.
 */
import { expect, test, type Page } from '@playwright/test';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..');
interface ScorpOwner { portalMagicTokens: string[]; markers: { returnFile: string }; taxYear: number }
const fixtures = JSON.parse(readFileSync(resolve(here, '..', '.artifacts', 'fixtures.json'), 'utf8')) as {
  portalPort?: number;
  scorp: ScorpOwner; scorpDesk: ScorpOwner;
};
const ownerFor = (project: string): ScorpOwner => (project === 'desk' ? fixtures.scorpDesk : fixtures.scorp);
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());

test.use({ baseURL: `http://localhost:${fixtures.portalPort ?? 3106}` });

async function signIn(page: Page, token: string): Promise<void> {
  await page.goto('/login');
  const status = await page.evaluate(async (t) => {
    const r = await fetch('/api/portal/auth/magic/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: t }) });
    localStorage.setItem('saos_portal_authed', '1');
    return r.status;
  }, token);
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
  const viewport = testInfo.project.name;
  const owner = ownerFor(viewport);
  const shot = testInfo.outputPath(`portal-returns-${viewport}.png`);
  let passed = false;
  try {
    // [1]: the dry run redeemed [0] for the client's turn, and the checkout walk takes [2].
    await signIn(page, owner.portalMagicTokens[1]!);
    await page.goto('/returns');
    await expect(page.getByRole('heading', { name: 'My Returns' })).toBeVisible();
    await page.waitForTimeout(1200);
    const text = await page.evaluate(() => document.body.innerText);
    expect(text, 'the delivered return is listed').toContain(owner.markers.returnFile);
    expect(text, 'with its year').toContain(String(owner.taxYear));
    expect(text, 'and a way to take a copy').toContain('Download');
    expect(text, 'nothing on the page is a raw ISO timestamp').not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    await page.screenshot({ path: shot, fullPage: true });
    passed = true;
  } finally {
    if (!existsSync(shot)) await page.screenshot({ path: shot, fullPage: true }).catch(() => undefined);
    testInfo.annotations.push({ type: 'screenshot', description: keepScreenshot(`portal-returns-${viewport}`, passed, shot) });
    testInfo.annotations.push({ type: 'walk-step', description: `A5|portal /returns (My Returns) at ${viewport}, the delivered return listed with its file name and year|client (portal sign-in link)|tap` });
  }
});
