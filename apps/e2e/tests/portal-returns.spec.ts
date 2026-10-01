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
import { redeemPortalToken } from './portal-sign-in';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { viewportKey } from './viewport';

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
  await redeemPortalToken(page, '', token);
}
function keepScreenshot(name: string, passed: boolean, file: string): string {
  const dir = passed ? resolve(here, '..', '.artifacts', today) : resolve(root, 'tasks', 'walks', today);
  mkdirSync(dir, { recursive: true });
  const target = resolve(dir, `${name}.png`);
  if (existsSync(file)) copyFileSync(file, target);
  return target;
}

test('the delivered 1120S is under My Returns for the owner', async ({ page }, testInfo) => {
  const viewport = viewportKey(testInfo);
  const owner = ownerFor(viewport);
  const shot = testInfo.outputPath(`portal-returns-${viewport}.png`);
  let passed = false;
  try {
    // [1]: the dry run redeemed [0] for the client's turn, and the checkout walk takes [2].
    await signIn(page, owner.portalMagicTokens[1]!);
    await page.goto('/returns');
    await expect(page.getByRole('heading', { name: 'My Returns' })).toBeVisible();
    // The heading is server-rendered; the list arrives only after hydration fetches /portal/returns,
    // which WebKit at 390 has started 1.8 s after the heading (receipt run 49). Wait for the row itself.
    await expect(page.getByText(owner.markers.returnFile), 'the delivered return is listed').toBeVisible();
    const text = await page.evaluate(() => document.body.innerText);
    expect(text, 'the delivered return is listed').toContain(owner.markers.returnFile);
    expect(text, 'with its year').toContain(String(owner.taxYear));
    expect(text, 'and a way to take a copy').toContain('Download');
    expect(text, 'nothing on the page is a raw ISO timestamp').not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    await page.screenshot({ path: shot, fullPage: true });
    // R84 (2026-09-27): Home's services card reads the completed return's answers, never "Completed · Deadline";
    // no Extended badge once filed; the bar is the five phases, every one done.
    await page.goto('/');
    const services = page.locator('section#services');
    await expect(services).toBeVisible();
    const filedLine = services.getByTestId('service-filed-status').first();
    await expect(filedLine).toHaveText(/^Filed\. Accepted by the IRS on [A-Z][a-z]{2} \d{1,2}, \d{4}\./);
    await expect(services, 'no deadline once filed').not.toContainText('Deadline');
    await expect(services, 'no Extended badge once filed').not.toContainText('Extended');
    await expect(services.getByTestId('service-phases').first()).toHaveAttribute('data-current', 'done');
    await expect(services.locator('[data-testid=service-phases] .seg.done').first()).toBeVisible();
    await expect(services.locator('[data-testid=service-phases]').first().locator('.seg')).toHaveCount(5);
    await expect(services.getByText('All five steps done').first()).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`portal-home-status-${viewport}.png`), fullPage: true });
    passed = true;
  } finally {
    if (!existsSync(shot)) await page.screenshot({ path: shot, fullPage: true }).catch(() => undefined);
    testInfo.annotations.push({ type: 'screenshot', description: keepScreenshot(`portal-returns-${viewport}`, passed, shot) });
    testInfo.annotations.push({ type: 'walk-step', description: `A5|portal /returns (My Returns) at ${viewport}, the delivered return listed with its file name and year|client (portal sign-in link)|tap` });
    if (passed) testInfo.annotations.push({ type: 'walk-step', description: `A5b|portal / (Home) services card at ${viewport}: the completed 1120S reads "Filed. Accepted by the IRS on <date>." with no Deadline and no Extended badge; the bar's five segments all done, "All five steps done"|client (portal sign-in link)|tap` });
  }
});
