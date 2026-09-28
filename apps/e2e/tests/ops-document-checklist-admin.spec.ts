/*
 * ADMIN → DOCUMENT CHECKLIST (Brian, 2026-09-27, R83) — at 390 × 844 and 1280 × 800, as the CEO fixture.
 *
 * B7d: the seeded checklist reads by item; one row's English words are edited and saved (the message
 * says the next checklist uses them), then put back; a document is added to an item through the add
 * form, then switched off, so it reaches no checklist another walk builds. The item is the clean
 * vehicle credit (IND_F8936), which no other walk quotes. The API spec (document-checklist.spec.ts)
 * proves what an edit does to the next acceptance and the role refusal.
 */
import { expect, test, type Page } from '@playwright/test';
import * as OTPAuth from 'otpauth';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
interface Persona { email: string; password: string; totpSecret: string }
const fixtures = JSON.parse(readFileSync(resolve(here, '..', '.artifacts', 'fixtures.json'), 'utf8')) as { staff: Persona };
const ROLES = 'ceo (admin.settings)';
const CONTROL = '/admin/document-checklist: a row\'s "English" textarea + "Save"; the "Add a document to an item" form ("Price-book item code", "Document key", "English", "Spanish", "Add document"), then the new row\'s "Asked for" checkbox off + "Save"';

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

test('B7d: Admin → Document checklist edits a row\'s words and adds a document to an item', async ({ page }, testInfo) => {
  const viewport = testInfo.project.name;
  await signIn(page, fixtures.staff);
  await page.goto('/admin/document-checklist');
  await expect(page.getByRole('heading', { level: 1, name: 'Document checklist' })).toBeVisible();
  const base = page.locator('[data-testid=checklist-item][data-item=IND_BASE_SINGLE]');
  await expect(base.getByTestId('checklist-row'), 'the base 1040 asks for its four').toHaveCount(4);

  const item = page.locator('[data-testid=checklist-item][data-item=IND_F8936]');
  const row = item.locator('[data-testid=checklist-row][data-doc=clean_vehicle_report]');
  const english = row.getByLabel('English');
  const original = await english.inputValue();
  await english.fill(`${original} (${viewport})`);
  await row.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByTestId('checklist-admin-message')).toContainText('IND_F8936 · clean_vehicle_report saved');
  await expect(row.getByLabel('English')).toHaveValue(`${original} (${viewport})`);
  // Put back, so the words stay Brian's.
  await row.getByLabel('English').fill(original);
  await row.getByRole('button', { name: 'Save' }).click();
  await expect(row.getByLabel('English')).toHaveValue(original);

  const docKey = `harness_extra_${viewport}`;
  await page.getByLabel('Price-book item code').fill('IND_F8936');
  await page.getByLabel('Document key').fill(docKey);
  const addCard = page.locator('section.card', { has: page.getByRole('heading', { name: 'Add a document to an item' }) });
  await addCard.getByLabel('English').fill('A synthetic extra document');
  await addCard.getByLabel('Spanish').fill('Un documento adicional sintético');
  await addCard.getByRole('button', { name: 'Add document' }).click();
  await expect(page.getByTestId('checklist-admin-message')).toContainText(`IND_F8936 · ${docKey} added`);
  const added = item.locator(`[data-testid=checklist-row][data-doc=${docKey}]`);
  await expect(added).toBeVisible();
  await added.getByLabel('Asked for').uncheck();
  await added.getByRole('button', { name: 'Save' }).click();
  await expect(added, 'switched off, it reaches no checklist').toContainText('off');
  const width = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(width.scroll, `no page-level horizontal scroll at ${viewport}`).toBeLessThanOrEqual(width.client);

  testInfo.annotations.push({ type: 'walk-step', description: `B7d|${CONTROL}|${ROLES}|tap` });
  testInfo.annotations.push({ type: 'edit-door', description: `document checklist row|${CONTROL}|${ROLES}|tap` });
});
