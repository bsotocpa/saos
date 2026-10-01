/*
 * R90 THE CUTOVER FACTS ON THE BUSINESS PAGE (Brian, 2026-09-29) — path Z, at 390 × 844 and 1280 × 800,
 * as the bookkeeper fixture (Marian's role, bookkeeping.assigned.manage).
 *
 *   Z1  A month the Trello import wrote from a card untouched since before 2026-09-21 reads
 *       "unconfirmed" beside "Books current through"; Correct → the month → Save: the line reads the
 *       corrected month, the badge and the door are gone, and the confirm task is completed.
 *   Z2  A client who files their own ST-1: the Sales tax line reads "client files their own ST-1
 *       (as of …)", and no sales-tax engagement exists.
 *
 * The facts are written by the importer's own functions in the fixture (apps/api/scripts/e2e-fixtures/
 * cutover.ts); everything read or pressed here is the screen.
 */
import { expect, test, type Page } from '@playwright/test';
import * as OTPAuth from 'otpauth';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { viewportKey } from './viewport';

const here = dirname(fileURLToPath(import.meta.url));
interface Persona { email: string; password: string; totpSecret: string }
interface Pair { unconfirmed: { businessId: string; name: string }; selfFiler: { businessId: string; name: string } }
const fixtures = JSON.parse(readFileSync(resolve(here, '..', '.artifacts', 'fixtures.json'), 'utf8')) as {
  wall: { bookkeeper: Persona }; cutover: { phone: Pair; desk: Pair };
};
const ROLE = 'bookkeeper (bookkeeping.assigned.manage)';

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

test('Z1–Z2: an unconfirmed "books current through" is corrected on the business page; a self-filer reads as one', async ({ page }, testInfo) => {
  const pair = viewportKey(testInfo) === 'desk' ? fixtures.cutover.desk : fixtures.cutover.phone;
  await signIn(page, fixtures.wall.bookkeeper);

  // ── Z1 ──
  await page.goto(`/businesses/${pair.unconfirmed.businessId}`);
  const facts = page.getByTestId('card-service-facts');
  await expect(facts.getByTestId('fact-books')).toHaveText(/^Jun 30, 2025 \(as of Sep 25, 2026\)$/);
  await expect(facts.getByTestId('fact-books-unconfirmed'), 'the import could not vouch for it').toHaveText('unconfirmed');
  const row = facts.getByTestId('books-confirm-row');
  await row.getByRole('button', { name: 'Correct', exact: true }).click();
  await row.getByLabel('Books current through (month)').fill('2025-09');
  await row.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(facts.getByTestId('fact-books')).toHaveText(/^Sep 30, 2025 \(as of [A-Z][a-z]{2} \d{1,2}, \d{4}\)$/);
  await expect(facts.getByTestId('fact-books-unconfirmed'), 'confirmed now').toHaveCount(0);
  await expect(facts.getByTestId('books-confirm-row'), 'the door closes').toHaveCount(0);
  const tasks = (await read(page, `/tasks/search?businessId=${pair.unconfirmed.businessId}&sourceType=trello_confirm_books_through&includeDone=true`)).tasks as Array<{ status: string }>;
  expect(tasks.map((t) => t.status), 'the confirm task completed').toEqual(['completed']);
  testInfo.annotations.push({ type: 'walk-step', description: `Z1|/businesses/:id Service facts: "Books current through" reads the imported month with the "unconfirmed" badge → button "Correct" → input "Books current through (month)" → button "Save" → the corrected month, no badge, no door; the confirm task completed|${ROLE}|tap` });

  // ── Z2 ──
  await page.goto(`/businesses/${pair.selfFiler.businessId}`);
  await expect(page.getByTestId('card-service-facts').getByTestId('fact-sales-tax')).toHaveText('client files their own ST-1 (as of Sep 25, 2026)');
  testInfo.annotations.push({ type: 'walk-step', description: `Z2|/businesses/:id Service facts: "Sales tax filing frequency" reads "client files their own ST-1 (as of <date>)" (no sales-tax engagement: cutover-facts.spec.ts)|${ROLE}|tap` });
});
