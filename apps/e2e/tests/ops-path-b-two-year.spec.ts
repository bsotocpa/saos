/*
 * PATH B, THE TWO-YEAR VARIANT (Brian, 2026-09-29, R89) — path Y, at 390 × 844 and 1280 × 800.
 *
 * One engagement, one return per year. The walk quotes the base return and its schedule for the
 * current tax year and three back, and reads what the ruling says acceptance does:
 *
 *   Y1  /pipeline: the base return and its schedule added from the book; "Also quote the same return
 *       for" ticks the year three back; the builder shows each year as its own group, the prior-year
 *       surcharge in the older group only, marked as added by the quote; Create and send.
 *   Y2  portal /quote/:token: one heading per year over that year's lines, the surcharge under the
 *       older year only; Accept.
 *   Y3  portal /invoices: the deposit invoice carries one line per year.
 *   Y4  portal Home: one row per year.
 *   Y5  /clients/:id Returns card: two returns, each at its own stage, both under one engagement.
 *
 * The person is the fixture's (apps/api/scripts/e2e-fixtures/path-b-two-year.ts), one per viewport;
 * the lines are the ones path B reads out of the book in force. No price is typed anywhere.
 */
import { expect, test, type Page } from '@playwright/test';
import * as OTPAuth from 'otpauth';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { viewportKey } from './viewport';

const here = dirname(fileURLToPath(import.meta.url));
interface Persona { email: string; password: string; totpSecret: string }
interface TwoYearPerson { contactId: string; fullName: string; lastName: string; portalMagicLinks: string[] }
const fixtures = JSON.parse(readFileSync(resolve(here, '..', '.artifacts', 'fixtures.json'), 'utf8')) as {
  port?: number; portalPort?: number; staff: Persona;
  pathB: { item: { code: string; name: string }; addOn: { code: string; name: string } };
  twoYear: { phone: TwoYearPerson; desk: TwoYearPerson; newYear: number; oldYear: number };
};
const PORTAL = `http://localhost:${fixtures.portalPort ?? 3106}`;
const ROLES = { quote: 'ceo (quotes.manage)', client: 'the client', read: 'ceo (engagements.read)' };
const rx = (s: string): RegExp => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
const SURCHARGE = /Prior-year surcharge/;

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
  const r = await fetch(`http://127.0.0.1:${fixtures.port ?? 3101}/harness/mail-links`);
  return ((await r.json()) as { quoteLinks: string[] }).quoteLinks;
}
async function read(page: Page, path: string): Promise<Record<string, unknown>> {
  return page.evaluate(async (p) => (await fetch(`/api${p}`)).json().catch(() => ({})), path);
}

test('Y1–Y5: two years of one return are one engagement with two returns; the surcharge on the older year only; one deposit line per year; two portal rows', async ({ page }, testInfo) => {
  const viewport = viewportKey(testInfo);
  const who = viewport === 'desk' ? fixtures.twoYear.desk : fixtures.twoYear.phone;
  const { newYear, oldYear } = fixtures.twoYear;
  const steps: string[] = [];
  await signIn(page, fixtures.staff);

  // ── Y1. THE QUOTE, two years ──
  await page.goto('/pipeline');
  await page.getByRole('button', { name: 'New quote' }).click();
  await page.getByPlaceholder('Search by name, email, or phone').fill(who.lastName);
  const chip = page.getByTestId('client-chip').filter({ hasText: who.fullName });
  await expect(chip).toHaveCount(1);
  await chip.click();
  for (const line of [fixtures.pathB.item.name, fixtures.pathB.addOn.name]) {
    await page.getByPlaceholder('Filter by name, form number or group').fill(line);
    const bookRow = page.locator('.qb-row', { hasText: rx(line) }).first();
    await bookRow.getByRole('button', { name: /^Add / }).click();
    await expect(page.locator('table.qb-lines')).toContainText(line);
  }
  await expect(page.getByText(new RegExp(`Tax year — ${newYear}`)), 'the tax year opens on the default').toBeVisible();
  const more = page.getByTestId('more-years');
  await more.getByLabel(new RegExp(`^${oldYear} · prior-year surcharge$`)).check();
  const newGroup = page.locator(`[data-testid=quote-year][data-year="${newYear}"]`);
  const oldGroup = page.locator(`[data-testid=quote-year][data-year="${oldYear}"]`);
  for (const g of [newGroup, oldGroup]) {
    await expect(g, 'each year repeats the return and its schedule').toContainText(fixtures.pathB.item.name);
    await expect(g).toContainText(fixtures.pathB.addOn.name);
  }
  await expect(oldGroup, 'the older year carries the surcharge the quote adds').toContainText(SURCHARGE);
  await expect(oldGroup).toContainText('added by the quote');
  await expect(newGroup, 'the current year carries none').not.toContainText(SURCHARGE);
  const linksBefore = (await quoteLinksSoFar()).length;
  await page.getByRole('button', { name: 'Create and send' }).click();
  await expect(page.getByRole('heading', { name: `Quote sent to ${who.fullName}` })).toBeVisible();
  const quoteHref = (await quoteLinksSoFar()).slice(linksBefore).pop()!;
  expect(quoteHref, 'the proposal reached the harness mailer').toBeTruthy();
  await page.locator('[role=dialog]').getByRole('button', { name: 'Dismiss' }).click();
  steps.push(`Y1|/pipeline "New quote" → the client's chip → the base return and its schedule "Add"ed from the book → "Also quote the same return for" ticked ${oldYear} → the builder's year groups: ${newYear} and ${oldYear} each with both lines, the prior-year surcharge in ${oldYear} only ("added by the quote") → "Create and send"|${ROLES.quote}|tap`);

  // ── Y2. THE PROPOSAL, one heading per year ──
  await page.goto(quoteHref);
  await expect(page.getByRole('heading', { name: 'Your proposal' })).toBeVisible();
  const pNew = page.locator(`[data-testid=quote-year-group][data-year="${newYear}"]`);
  const pOld = page.locator(`[data-testid=quote-year-group][data-year="${oldYear}"]`);
  await expect(pNew.getByRole('heading', { name: `Tax year ${newYear}` })).toBeVisible();
  await expect(pOld.getByRole('heading', { name: `Tax year ${oldYear}` })).toBeVisible();
  await expect(pOld).toContainText(SURCHARGE);
  await expect(pNew).not.toContainText(SURCHARGE);
  await page.getByRole('button', { name: 'Accept and start the work' }).click();
  await expect(page.getByRole('heading', { name: 'You’re all set' })).toBeVisible();
  steps.push(`Y2|portal /quote/:token: headings "Tax year ${newYear}" and "Tax year ${oldYear}" over their lines, the surcharge under ${oldYear} only → button "Accept and start the work"|${ROLES.client}|tap`);

  // ── Y3. THE DEPOSIT INVOICE, one line per year ──
  await page.goto(who.portalMagicLinks[0]!);
  await page.getByTestId('verify-press').click();
  await page.waitForURL((u) => new URL(u).pathname === '/');
  await page.goto(`${PORTAL}/invoices`);
  const deposit = page.locator('li', { hasText: `Deposit — ${newYear}` });
  await expect(deposit, 'one invoice, one line per year').toContainText(`Deposit — ${newYear} · Deposit — ${oldYear}`);
  steps.push(`Y3|portal /invoices: the deposit invoice reads "Deposit — ${newYear} · Deposit — ${oldYear}"|${ROLES.client}|tap`);

  // ── Y4. HOME, one row per year ──
  await page.goto(`${PORTAL}/`);
  const services = page.locator('#services');
  await expect(services.getByText(`${newYear} · 1040`, { exact: true })).toBeVisible();
  await expect(services.getByText(`${oldYear} · 1040`, { exact: true })).toBeVisible();
  steps.push(`Y4|portal / (Home) services card: two rows, "${newYear} · 1040" and "${oldYear} · 1040"|${ROLES.client}|tap`);

  // ── Y5. OPS, two returns under one engagement ──
  await signIn(page, fixtures.staff);
  await page.goto(`/clients/${who.contactId}`);
  const rows = page.locator('.quote-line .name');
  await expect(rows.filter({ hasText: `${newYear} 1040` })).toHaveCount(1);
  await expect(rows.filter({ hasText: `${oldYear} 1040` })).toHaveCount(1);
  const list = (await read(page, `/tax-engagements?contactId=${who.contactId}`)).taxEngagements as Array<{ engagement_id: string; tax_year: number; stage: string }>;
  expect(list.map((t) => t.tax_year).sort(), 'two returns').toEqual([oldYear, newYear].sort());
  expect(new Set(list.map((t) => t.engagement_id)).size, 'one engagement').toBe(1);
  expect(list.every((t) => t.stage === 'intake_started'), 'each at its own stage, both opening at intake').toBe(true);
  steps.push(`Y5|/clients/:id Returns card: rows "${newYear} 1040" and "${oldYear} 1040", both on one engagement (GET /tax-engagements?contactId= read back)|${ROLES.read}|tap`);

  for (const s of steps) testInfo.annotations.push({ type: 'walk-step', description: s });
});
