/*
 * THE QUOTE BUILDER SWITCH (Brian, 2026-09-20). OPS_QUOTE_BUILDER decides which builder /pipeline
 * renders: v1, the chip builder production runs today and the default; v2, the redesign, shown
 * only when the server says so. One API process serves both: the harness door
 * /harness/quote-builder flips it, and this spec reads what a person sees in each state, at 390
 * and 1280 — v1's chip catalog and its "Quote as a range" checkbox; v2's grouped rows and
 * "This quote". The switch is put back to v2 whatever happens, so the specs after this one tap
 * the redesign.
 */
import { expect, test, type Page } from '@playwright/test';
import * as OTPAuth from 'otpauth';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
interface Persona { email: string; password: string; totpSecret: string }
const fixtures = JSON.parse(readFileSync(resolve(here, '..', '.artifacts', 'fixtures.json'), 'utf8')) as {
  staff: Persona;
  scorp: { apiPort: number };
};
const API = `http://127.0.0.1:${fixtures.scorp.apiPort ?? 3101}`;

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

/** The harness's own flip: the body is the version, the answer is the version now held. */
async function flip(version: 'v1' | 'v2'): Promise<string> {
  const r = await fetch(`${API}/harness/quote-builder`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ version }) });
  const body = (await r.json().catch(() => ({}))) as { quoteBuilder?: string };
  if (r.status !== 200) throw new Error(`the harness flip answered ${r.status}: ${JSON.stringify(body)}`);
  return body.quoteBuilder ?? '';
}

test('v1 renders the chip builder with "Quote as a range"; v2 renders the grouped rows beside "This quote"', async ({ page }, testInfo) => {
  const viewport = testInfo.project.name;
  const shot = testInfo.outputPath(`quote-builder-switch-${viewport}.png`);
  try {
    await signIn(page, fixtures.staff);

    // v1: the production default.
    expect(await flip('v1'), 'the switch is v1 for this half').toBe('v1');
    const me1 = await page.evaluate(async () => (await fetch('/api/auth/me')).json() as Promise<{ switches?: { quoteBuilder?: string } }>);
    expect(me1.switches?.quoteBuilder, 'the session reports the version the page decides from').toBe('v1');
    await page.goto('/pipeline');
    await page.getByRole('button', { name: 'New quote' }).click();
    const builder = page.locator('section.card', { has: page.getByRole('heading', { name: 'Build a quote' }) });
    await expect(builder).toBeVisible();
    await expect(builder.getByPlaceholder('Filter the price book'), 'v1: the old filter').toBeVisible();
    await expect(builder.locator('.chipbar button.chip').first(), 'v1: the chip catalog').toBeVisible();
    await expect(builder.getByText('Quote as a range (one-time work). Uncheck for recurring work, which quotes exact.'), 'v1: the range checkbox').toBeVisible();
    await expect(builder.locator('.qb-group'), 'v1 shows no grouped rows').toHaveCount(0);
    await expect(builder.getByText('This quote'), 'v1 has no "This quote" panel').toHaveCount(0);
    await page.screenshot({ path: shot, fullPage: false });

    // v2: the redesign.
    expect(await flip('v2'), 'the switch is v2 for this half').toBe('v2');
    await page.goto('/pipeline');
    await page.getByRole('button', { name: 'New quote' }).click();
    await expect(builder).toBeVisible();
    await expect(builder.locator('.qb-group').first(), 'v2: the grouped rows').toBeVisible();
    await expect(builder.getByText('This quote'), 'v2: the quote panel').toBeVisible();
    await expect(builder.getByPlaceholder('Filter by name, form number or group'), 'v2: the new filter').toBeVisible();
    await expect(builder.locator('.chipbar button.chip'), 'v2 shows no chip catalog').toHaveCount(0);
  } finally {
    // Whatever happened above, the specs after this one tap v2.
    expect(await flip('v2'), 'the switch is back to v2').toBe('v2');
  }
});
