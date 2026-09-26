/*
 * THE PORTAL AFTER SIGNING (Brian, 2026-09-26, R46) — walk step P2, at 390 × 844 and 1280 × 800.
 *
 * On the signing fixture (apps/api/scripts/e2e-fixtures/portal-signing.ts: a withdrawn 1040 with an
 * engagement-letter envelope, an accepted 1120-S quote with TWO engagement-letter envelopes, the
 * packet sent), the client signs in, reads the home and the sign page BEFORE signing — one row for
 * the letter, not two, and nothing of the withdrawn 1040 — signs the packet, and reads them again:
 * no "Waiting for your signature" for the signed document, the sign page's row reads "Signed on",
 * and "Being prepared" is nowhere.
 */
import { expect, test, type Page } from '@playwright/test';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..');
interface Person { contactId: string; businessName: string; taxYear: number; portalMagicTokens: string[] }
const fixtures = JSON.parse(readFileSync(resolve(here, '..', '.artifacts', 'fixtures.json'), 'utf8')) as {
  portalPort?: number;
  signing: { phone: Person; desk: Person };
};
const personFor = (project: string): Person => (project === 'desk' ? fixtures.signing.desk : fixtures.signing.phone);
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
const CONTROL = 'portal / "Waiting for your signature" rows and /sign envelope rows, then /sign "Your engagement agreement": two affirmations, "Type your full name to sign", "Sign the agreement"';

test.use({ baseURL: `http://localhost:${fixtures.portalPort ?? 3106}` });

async function signIn(page: Page, token: string): Promise<void> {
  await page.goto('/login');
  const status = await page.evaluate(async (t) => {
    const r = await fetch('/api/portal/auth/magic/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: t }) });
    localStorage.setItem('saos_portal_authed', '1');
    return r.status;
  }, token);
  expect(status, 'redeeming the sign-in link the client was emailed').toBe(200);
}
function keepScreenshot(name: string, passed: boolean, file: string): string {
  const dir = passed ? resolve(here, '..', '.artifacts', today) : resolve(root, 'tasks', 'walks', today);
  mkdirSync(dir, { recursive: true });
  const target = resolve(dir, `${name}.png`);
  if (existsSync(file)) copyFileSync(file, target);
  return target;
}

test('P2: one row before signing, none of the withdrawn 1040, and nothing waiting after the signature', async ({ page }, testInfo) => {
  const viewport = testInfo.project.name;
  const person = personFor(viewport);
  const shot = testInfo.outputPath(`portal-signing-home-${viewport}.png`);
  let passed = false;
  try {
    await signIn(page, person.portalMagicTokens[0]!);

    // BEFORE: the letter waits once, named by its business; the withdrawn 1040's letter is nowhere.
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Waiting for your signature' })).toBeVisible();
    const waiting = page.getByTestId('unsigned-row');
    await expect(waiting, 'two envelopes on one engagement are one row').toHaveCount(1);
    await expect(waiting.first()).toContainText(`Engagement letter — ${person.businessName}`);
    let text = await page.evaluate(() => document.body.innerText);
    expect(text, 'the withdrawn 1040 contributes nothing').not.toMatch(/1040 2023/);

    await page.goto('/sign');
    const rows = page.getByTestId('envelope-row');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText(`Engagement letter — ${person.businessName}`);
    text = await page.evaluate(() => document.body.innerText);
    expect(text).not.toMatch(/1040 2023/);

    // THE SIGNATURE, in the portal.
    const packetCard = page.locator('section.card', { has: page.getByRole('heading', { name: 'Your engagement agreement' }) });
    await expect(packetCard).toBeVisible();
    await expect(packetCard, 'the accepted 1120-S line is Schedule B, and B alone').toContainText('Schedule B');
    await expect(packetCard).not.toContainText('Schedule A');
    for (const box of await packetCard.locator('input[type=checkbox]').all()) await box.check();
    await packetCard.getByLabel('Type your full name to sign').fill(`Synthetic ${person.businessName} Owner`);
    await packetCard.getByRole('button', { name: 'Sign the agreement' }).click();
    await expect(page.getByRole('heading', { name: 'Signed — thank you' })).toBeVisible();

    // AFTER: the sign page's row reads the day it was signed; "Being prepared" is gone.
    await page.goto('/sign');
    await expect(page.getByTestId('envelope-row')).toHaveCount(1);
    await expect(page.locator('[data-testid=envelope-row][data-status=completed]')).toHaveCount(1);
    await expect(page.getByTestId('envelope-row').first()).toContainText(/Signed on /);
    text = await page.evaluate(() => document.body.innerText);
    expect(text, 'a signed document never reads as being prepared').not.toContain('Being prepared');

    // AND THE HOME: nothing waits for a signature.
    await page.goto('/');
    await page.waitForTimeout(800);
    await expect(page.getByRole('heading', { name: 'Waiting for your signature' })).toHaveCount(0);
    await expect(page.getByTestId('unsigned-row')).toHaveCount(0);
    text = await page.evaluate(() => document.body.innerText);
    expect(text).not.toMatch(/1040 2023/);
    await page.screenshot({ path: shot, fullPage: true });
    passed = true;
  } finally {
    if (!existsSync(shot)) await page.screenshot({ path: shot, fullPage: true }).catch(() => undefined);
    testInfo.annotations.push({ type: 'screenshot', description: keepScreenshot(`portal-signing-home-${viewport}`, passed, shot) });
    testInfo.annotations.push({ type: 'walk-step', description: `P2|${CONTROL} at ${viewport}: one letter row before signing (two envelopes folded, the withdrawn 1040 absent), the packet signed with Schedule B alone, then "Signed on" on /sign and no "Waiting for your signature" on the home|client (portal sign-in link)|tap` });
  }
});
