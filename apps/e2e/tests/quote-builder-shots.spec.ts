/*
 * THE QUOTE BUILDER, FOR BRIAN'S APPROVAL (2026-09-20). Four states of the redesigned builder at
 * three widths — 390, 768 and 1280 — saved as full-page PNGs under C:\Users\brian\saos-shots\
 * quote-builder\<state>-<width>.png:
 *
 *   empty     the builder as it opens
 *   business  a business quote with four lines, one amount edited, the reason field showing
 *   error     the inline error: a reason with a chat artifact refused by the server, its words
 *             beside the reason field, the typed text still there
 *   package   a package applied, its lines filled and editable
 *
 * One project sets the three widths itself (the other project skips), signed in as the CEO
 * fixture. Nothing is created: the one submit is the refused one. Beside the pictures, the spec
 * reads what a person would: the error's words, the kept text, and 44px targets at 390.
 */
import { expect, test, type Page } from '@playwright/test';
import * as OTPAuth from 'otpauth';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
interface Persona { email: string; password: string; totpSecret: string }
const fixtures = JSON.parse(readFileSync(resolve(here, '..', '.artifacts', 'fixtures.json'), 'utf8')) as {
  staff: Persona;
  scorp: { contactId: string; businessId: string; itemCode: string; ownerEmail: string };
};
const SHOTS = 'C:\\Users\\brian\\saos-shots\\quote-builder';
const WIDTHS: Array<{ width: number; height: number }> = [
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 1280, height: 800 },
];

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

test('the four builder states at 390, 768 and 1280', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desk', 'one project sets the three widths itself');
  test.setTimeout(600_000); // twelve full-page pictures across three widths, on the production build
  mkdirSync(SHOTS, { recursive: true });
  await signIn(page, fixtures.staff);
  const saved: string[] = [];
  const shot = async (state: string, width: number) => {
    const path = resolve(SHOTS, `${state}-${width}.png`);
    await page.screenshot({ path, fullPage: true });
    saved.push(path);
  };

  for (const size of WIDTHS) {
    await page.setViewportSize(size);
    await page.goto('/pipeline');
    await page.getByRole('button', { name: 'New quote' }).click();
    const builder = page.locator('section.card', { has: page.getByRole('heading', { name: 'Build a quote' }) });
    await expect(builder).toBeVisible();
    await expect(builder.getByText('This quote')).toBeVisible();
    await expect(builder.locator('.qb-group').first(), 'the catalog renders as groups').toBeVisible();
    const pageText = await page.evaluate(() => document.body.innerText);
    expect(pageText, 'the old "range is applied when built" line is gone').not.toMatch(/a range is applied when the quote is built/);
    // 1. EMPTY.
    await shot('empty', size.width);

    // 2. BUSINESS: the S corp owner, the business, four book lines, one amount edited.
    await builder.getByPlaceholder('Search by name, email, or phone').fill(fixtures.scorp.ownerEmail);
    const candidate = builder.locator('button.chip', { hasText: 'Synthetic' }).first();
    await expect(candidate).toBeVisible();
    await candidate.click();
    await builder.getByLabel(/^Business/).selectOption(fixtures.scorp.businessId);
    const filter = builder.getByPlaceholder('Filter by name, form number or group');
    const add = async (query: string, rowText: string | RegExp) => {
      await filter.fill(query);
      const row = builder.locator('.qb-row', { hasText: rowText }).first();
      await expect(row, `${query} is in the book`).toBeVisible();
      await row.getByRole('button', { name: /^Add / }).click();
    };
    await add(fixtures.scorp.itemCode, '1120-S');
    await add('BIZ_ADDL_STATE', 'Additional state return (business)');
    await add('BIZ_AMENDMENT', 'Amended business return');
    await add('BIZ_NOTICE_SUPPORT', 'Notice support (business)');
    await filter.fill('');
    const lines = builder.locator('table.qb-lines tbody tr');
    await expect(lines).toHaveCount(4);
    if (size.width === 390) {
      // Every target at least 44px tall on the phone: the first Add, a Remove, the amount box, the group header.
      // The first rows are already "Added"; the first row still offering Add is the target.
      for (const target of [
        builder.getByRole('button', { name: /^Add / }).first(),
        builder.getByRole('button', { name: /^Remove / }).first(),
        builder.getByLabel(/^Unit amount for/).first(),
        builder.locator('.qb-group > summary').first(),
      ]) {
        const box = await target.boundingBox();
        expect(box && box.height >= 44, `a 44px target at 390 (got ${box?.height})`).toBeTruthy();
      }
    }
    const stateAmount = builder.getByLabel('Unit amount for Additional state return (business)');
    await stateAmount.fill('300');
    await expect(builder.locator('table.qb-lines s.qb-book'), 'the book price, struck through, beside the edited amount').toBeVisible();
    const reasonField = builder.locator('label', { hasText: /priced off the book\?/ });
    await expect(reasonField, 'the one reason field appears').toBeVisible();
    const reason = reasonField.locator('textarea');
    await reason.fill('Two states this year; the second is a short-year return with one page of activity.');
    await shot('business', size.width);

    // 3. ERROR: a chat artifact in the reason; the server's words beside the field; the text kept.
    const typed = 'per ruling 3, the client agreed to this';
    await reason.fill(typed);
    await builder.getByRole('button', { name: 'Save as draft' }).click();
    const error = builder.locator('.field-error');
    await expect(error).toBeVisible();
    await expect(error).toContainText('a ruling number points into a conversation');
    await expect(reason).toHaveValue(typed);
    const afterText = await page.evaluate(() => document.body.innerText);
    expect(afterText, 'nothing reads "request failed"').not.toMatch(/request failed/i);
    expect(afterText, 'nothing was saved').not.toMatch(/Draft saved\./);
    const fieldBox = await reason.boundingBox();
    const errBox = await error.boundingBox();
    expect(errBox && fieldBox && errBox.y >= fieldBox.y && errBox.y - (fieldBox.y + fieldBox.height) < 80, 'the error is right under the field').toBeTruthy();
    await shot('error', size.width);

    // 4. PACKAGE: choosing one fills the lines; every line stays editable.
    await builder.getByLabel('Package').selectOption('s-corp-conversion');
    // The compose is a fetch: the lines are read once it lands, not the instant the select changes.
    await expect.poll(async () => lines.count(), { message: 'the package filled its lines' }).toBeGreaterThan(4);
    await expect(builder.locator('.qb-toolbar ~ .field-error'), 'the package was not refused').toHaveCount(0);
    await expect(builder.getByLabel(/^Unit amount for/).first(), 'the filled lines are editable').toBeEditable();
    await shot('package', size.width);

    await page.getByRole('button', { name: 'Close builder' }).click();
  }
  for (const p of saved) testInfo.annotations.push({ type: 'screenshot', description: p });
  expect(saved.length, 'twelve pictures').toBe(12);
});
