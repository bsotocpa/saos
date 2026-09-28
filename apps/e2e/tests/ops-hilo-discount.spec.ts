/*
 * THE HILO REFERRAL DISCOUNT ON A HARNESS QUOTE (Brian, 2026-09-27, R75) — path V, at 390 × 844 and
 * 1280 × 800. The harness book is v6, published by the boot through the version door effective the
 * harness's today; one Hilo-referred client per viewport, no engagement yet, one business.
 *
 *   V1  the CEO builds the quote in Ops: the tax-return line and a recurring line; the builder shows
 *       "Hilo referral discount (50%)" at half the tax-return line and nothing off the recurring line;
 *       Create and send;
 *   V2  the client opens the proposal they were emailed: the discount is its own row, in their words;
 *   V3  the CEO removes it on the Ops quote page with a reason: the row reads removed with the reason,
 *       the total returns to the book's;
 *   V4  the role proof: the preparer reads the quote with no Remove control, and the route refuses
 *       "This session does not hold quotes.referral_discount.remove."
 */
import { expect, test, type Page } from '@playwright/test';
import * as OTPAuth from 'otpauth';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..');
interface Persona { email: string; password: string; totpSecret: string }
interface HiloClient { contactId: string; fullName: string; lastName: string; businessName: string }
const fixtures = JSON.parse(readFileSync(resolve(here, '..', '.artifacts', 'fixtures.json'), 'utf8')) as {
  port: number;
  staff: Persona;
  wall: { anamaria: Persona };
  hilo: { phone: HiloClient; desk: HiloClient; reached: { itemCode: string; name: string }; notReached: { itemCode: string; name: string } };
};
const API = `http://127.0.0.1:${fixtures.port}`;
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
const REASON = 'The referral came through a staff member\'s family; full price agreed with the client.';
const money = (cents: number) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const rx = (s: string) => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

const V1 = '/pipeline button "New quote" → client chip → "Business" select → "Filter by name, form number or group" + the rows\' "Add" (the tax-return line, a recurring line) → .qb-totals row data-testid qb-referral-discount "Hilo referral discount (50%) −<half the tax-return line>" → button "Create and send"';
const V2 = 'portal /quote/:token (the link the client was emailed): row data-testid quote-referral-discount "Hilo referral discount (50%) −<amount>" between Subtotal and Total';
const V3 = '/quotes/:id row data-testid quote-referral-discount; button "Remove the Hilo discount…" → modal "Remove the Hilo referral discount from this quote?", textarea "Why is the discount being removed?", button "Remove the discount" → data-testid quote-referral-removed with the reason; the total returns to the book\'s';
const V4 = 'role proof: tax_preparer on /quotes/:id sees the discount and no "Remove the Hilo discount…"; POST /quotes/:id/referral-discount/remove refused 403 "This session does not hold quotes.referral_discount.remove."';

const code = (secret: string) => new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) }).generate();
async function signIn(page: Page, who: Persona): Promise<void> {
  await page.goto('/login');
  const status = await page.evaluate(async ({ email, password, totp }) => {
    const r = await fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password, totp }) });
    sessionStorage.setItem('saos_staff_authed', '1');
    return r.status;
  }, { email: who.email, password: who.password, totp: code(who.totpSecret) });
  expect(status, `${who.email} signs in`).toBe(200);
}
async function signOut(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
    sessionStorage.removeItem('saos_staff_authed');
  });
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

test.describe('Ops → the Hilo referral discount on a quote (R75)', () => {
  test('V1–V4: half off the tax-return line in the builder, its own row for the client, removed by the CEO with a reason, refused to the preparer', async ({ page }, testInfo) => {
    test.setTimeout(240_000);
    const viewport = testInfo.project.name as 'phone' | 'desk';
    const who = fixtures.hilo[viewport];
    const shots: Record<string, string> = {};
    const shot = (step: string) => (shots[step] = testInfo.outputPath(`hilo-${step}-${viewport}.png`));
    const cleared = new Set<string>();
    try {
      await signIn(page, fixtures.staff);
      // The book's figures for the two lines, from the catalog the builder itself reads.
      const catalog = await page.evaluate(async () => (await (await fetch('/api/quotes/catalog')).json()) as { items: Array<{ item_code: string; amount_cents: number | null }> });
      const priceOf = (itemCode: string) => catalog.items.find((i) => i.item_code === itemCode)?.amount_cents ?? 0;
      const reachedCents = priceOf(fixtures.hilo.reached.itemCode);
      const notReachedCents = priceOf(fixtures.hilo.notReached.itemCode);
      expect(reachedCents, 'the tax-return line has a price in the book').toBeGreaterThan(0);
      const half = Math.round(reachedCents / 2);

      // ── V1: the builder.
      await page.goto('/pipeline');
      await page.waitForLoadState('networkidle');
      await page.getByRole('button', { name: 'New quote' }).click();
      await page.getByPlaceholder('Search by name, email, or phone').fill(who.lastName);
      const chip = page.getByTestId('client-chip').filter({ hasText: who.fullName });
      await expect(chip).toBeVisible();
      await chip.click();
      // The recurring line is business work: the quote names the client's business.
      const businessSelect = page.locator('label.field', { hasText: /^Business/ }).locator('select');
      const businessValue = await businessSelect.locator('option', { hasText: who.businessName }).getAttribute('value');
      await businessSelect.selectOption(businessValue!);
      for (const line of [fixtures.hilo.reached.name, fixtures.hilo.notReached.name]) {
        await page.getByPlaceholder('Filter by name, form number or group').fill(line);
        const row = page.locator('.qb-row', { hasText: rx(line) }).first();
        await expect(row, `${line} is in the book in force`).toBeVisible();
        await row.getByRole('button', { name: /^Add / }).click();
        await expect(page.locator('table.qb-lines')).toContainText(line);
      }
      const discountRow = page.getByTestId('qb-referral-discount');
      await expect(discountRow).toContainText('Hilo referral discount (50%)');
      await expect(discountRow, 'half the tax-return line, nothing off the recurring line').toContainText(money(half));
      await expect(page.locator('.qb-total-row', { hasText: 'Subtotal' })).toContainText(money(reachedCents + notReachedCents));
      await page.screenshot({ path: shot('V1'), fullPage: true });
      const before = (await quoteLinksSoFar()).length;
      await page.getByRole('button', { name: 'Create and send' }).click();
      await expect(page.getByRole('heading', { name: `Quote sent to ${who.fullName}` })).toBeVisible();
      const links = (await quoteLinksSoFar()).slice(before);
      expect(links.length, 'the proposal reached the harness mailer').toBeGreaterThan(0);
      const quoteHref = links[links.length - 1]!;
      await page.locator('[role=dialog]').getByRole('button', { name: 'Dismiss' }).click();
      const quoteId = await page.evaluate(async (contactId) => {
        const r = await fetch(`/api/contacts/${contactId}/quotes`);
        const j = (await r.json()) as { quotes: Array<{ id: string; status: string }> };
        return j.quotes.find((q) => q.status === 'sent')?.id ?? '';
      }, who.contactId);
      expect(quoteId, 'the sent quote is on the record').not.toBe('');
      const server = await page.evaluate(async (id) => (await (await fetch(`/api/quotes/${id}`)).json()) as { quote: { referral_discount_cents: number; total_cents: number } }, quoteId);
      expect(server.quote.referral_discount_cents, 'the server applied what the builder showed').toBe(half);
      cleared.add('V1');

      // ── V2: the client's proposal.
      await signOut(page);
      await page.goto(quoteHref);
      const clientRow = page.getByTestId('quote-referral-discount');
      await expect(clientRow).toContainText('Hilo referral discount');
      await expect(clientRow).toContainText('50%');
      await expect(clientRow).toContainText(money(half));
      await page.screenshot({ path: shot('V2'), fullPage: true });
      cleared.add('V2');

      // ── V3: the CEO removes it, with a reason.
      await signIn(page, fixtures.staff);
      await page.goto(`/quotes/${quoteId}`);
      await page.waitForLoadState('networkidle');
      await expect(page.getByTestId('quote-referral-discount')).toContainText(money(half));
      await page.getByTestId('remove-referral-discount').click();
      const modal = page.locator('[role=dialog]', { hasText: 'Remove the Hilo referral discount from this quote?' });
      await expect(modal).toBeVisible();
      await modal.getByLabel(/Why is the discount being removed\?/).fill(REASON);
      await modal.getByRole('button', { name: 'Remove the discount' }).click();
      await expect(modal).toHaveCount(0);
      await expect(page.getByTestId('quote-referral-removed')).toContainText(REASON);
      await expect(page.getByTestId('quote-referral-discount')).toHaveCount(0);
      await expect(page.getByTestId('quote-total')).toContainText(money(reachedCents + notReachedCents));
      await page.screenshot({ path: shot('V3'), fullPage: true });
      cleared.add('V3');

      // ── V4: the role proof, on a second quote that still carries the discount.
      const second = await page.evaluate(async ({ contactId, items }) => {
        const r = await fetch('/api/quotes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ contactId, lines: items.map((itemCode: string) => ({ itemCode })) }) });
        return ((await r.json()) as { id: string }).id;
      }, { contactId: who.contactId, items: [fixtures.hilo.reached.itemCode] });
      await signOut(page);
      await signIn(page, fixtures.wall.anamaria);
      await page.goto(`/quotes/${second}`);
      await page.waitForLoadState('networkidle');
      await expect(page.getByTestId('quote-referral-discount'), 'the preparer reads the discount').toContainText(money(half));
      await expect(page.getByTestId('remove-referral-discount'), 'and has no control').toHaveCount(0);
      const refused = await page.evaluate(async ({ id, reason }) => {
        const r = await fetch(`/api/quotes/${id}/referral-discount/remove`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason }) });
        return { status: r.status, body: (await r.json()) as { message?: string } };
      }, { id: second, reason: REASON });
      expect(refused.status).toBe(403);
      expect(refused.body.message).toBe('This session does not hold quotes.referral_discount.remove.');
      await page.screenshot({ path: shot('V4'), fullPage: true });
      cleared.add('V4');
    } finally {
      for (const step of ['V1', 'V2', 'V3', 'V4']) {
        const file = shots[step] ?? testInfo.outputPath(`hilo-${step}-${viewport}.png`);
        if (!shots[step] && !existsSync(file)) await page.screenshot({ path: file, fullPage: true }).catch(() => undefined);
        testInfo.annotations.push({ type: 'screenshot', description: keepScreenshot(`hilo-${step}-${viewport}`, cleared.has(step), file) });
      }
      const controls: Record<string, string> = { V1, V2, V3, V4 };
      const roles: Record<string, string> = {
        V1: 'ceo (engagements.read, quotes)', V2: 'the client (the link in their inbox)',
        V3: 'ceo (quotes.referral_discount.remove, explicit-only)', V4: 'role proof: tax_preparer sees no control, POST refused 403',
      };
      for (const step of cleared) testInfo.annotations.push({ type: 'walk-step', description: `${step}|${controls[step]}|${roles[step]}|tap` });
    }
  });
});
