/*
 * WALK STEP 1, ADD A BUSINESS (Brian, 2026-09-19, report item 6): the business is added on the
 * client's record, in the Businesses card, through the same modal as everything else: legal name,
 * entity type, state, EIN, formation date, set as primary. The harness taps it at 390 and 1280 as
 * the CEO and proves the refusal renders beside the control that caused it (a formation date after
 * today).
 *
 * WHO ELSE (2026-09-19 evening, R4): the route accepts contacts.write OR businesses.write, and the
 * entity VA holds the second one — so Laura taps the control here too, successfully. The role proof
 * moved to the bookkeeper, who holds neither: no button on her page, and the route refuses her.
 */
import { expect, test, type Page } from '@playwright/test';
import * as OTPAuth from 'otpauth';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..');
interface Persona { email: string; password: string; totpSecret: string }
const fixtures = JSON.parse(readFileSync(resolve(here, '..', '.artifacts', 'fixtures.json'), 'utf8')) as {
  contactId: string;
  staff: Persona;
  wall: { laura: Persona; bookkeeper: Persona };
};
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
const CONTROL = '/clients/:id Businesses card, button "Add a business", form#add-business-form, button "Add business"';
const ROLES = 'ceo, comms_billing (contacts.write); va_entity (businesses.write)';

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
function keepScreenshot(name: string, passed: boolean, file: string): string {
  const dir = passed ? resolve(here, '..', '.artifacts', today) : resolve(root, 'tasks', 'walks', today);
  mkdirSync(dir, { recursive: true });
  const target = resolve(dir, `${name}.png`);
  if (existsSync(file)) copyFileSync(file, target);
  return target;
}
const plusDays = (n: number): string => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

test.describe('Add a business on the client page', () => {
  test('the CEO adds a business with its EIN and makes it primary; a refusal renders beside its control', async ({ page }, testInfo) => {
    const viewport = testInfo.project.name;
    const shot = testInfo.outputPath(`add-business-${viewport}.png`);
    const name = `HARNESS-ADDED-${viewport.toUpperCase()} LLC`;
    let passed = false;
    try {
      await signIn(page, fixtures.staff);
      await page.goto(`/clients/${fixtures.contactId}`);
      await page.getByRole('button', { name: 'Add a business' }).click();
      const form = page.locator('#add-business-form');
      await expect(form).toBeVisible();
      await form.getByLabel(/Legal name/).fill(name);
      await form.getByLabel(/Entity type/).selectOption('s_corp');
      await form.getByLabel(/^State/).fill('IL');
      await form.getByLabel(/EIN/).fill('12-3456789');
      // A formation date after today is refused by the route; the words land beside the date control and the text stays.
      await form.getByLabel(/Formation date/).fill(plusDays(3));
      await form.getByLabel(/Make this the primary business/).check();
      await page.getByRole('button', { name: 'Add business' }).click();
      const dateError = form.locator('.field-error[data-field="formationDate"]');
      await expect(dateError, 'the refusal sits beside the formation date').toBeVisible();
      await expect(dateError, "with the server's words").toContainText('A formation date is a thing that already happened.');
      await expect(form.getByLabel(/Legal name/), 'the name is still there').toHaveValue(name);
      // The real date, then the business is on the card, primary.
      await form.getByLabel(/Formation date/).fill('2020-01-15');
      await page.getByRole('button', { name: 'Add business' }).click();
      await expect(page.getByText('Business added.')).toBeVisible();
      await expect(form).toHaveCount(0);
      const card = page.locator('section.card', { has: page.getByRole('heading', { name: 'Businesses' }) });
      await expect(card).toContainText(name);
      const row = card.locator('li, div', { hasText: name }).first();
      await expect(row, 'the EIN is on the card').toContainText('EIN on file');
      await expect(row, 'it is the primary business').toContainText('primary');
      await page.screenshot({ path: shot, fullPage: true });
      passed = true;
    } finally {
      if (!existsSync(shot)) await page.screenshot({ path: shot, fullPage: true }).catch(() => undefined);
      testInfo.annotations.push({ type: 'screenshot', description: keepScreenshot(`add-business-${viewport}`, passed, shot) });
      testInfo.annotations.push({ type: 'walk-step', description: `A1|${CONTROL}|${ROLES}|tap` });
    }
  });

  test('Laura (va_entity) adds a business through businesses.write', async ({ page }, testInfo) => {
    const viewport = testInfo.project.name;
    const shot = testInfo.outputPath(`add-business-laura-${viewport}.png`);
    // A distinct name per viewport: both projects run against the same harness database.
    const name = `HARNESS-LAURA-${viewport.toUpperCase()} LLC`;
    let passed = false;
    try {
      await signIn(page, fixtures.wall.laura);
      await page.goto(`/clients/${fixtures.contactId}`);
      await page.getByRole('button', { name: 'Add a business' }).click();
      const form = page.locator('#add-business-form');
      await expect(form).toBeVisible();
      await form.getByLabel(/Legal name/).fill(name);
      await form.getByLabel(/Entity type/).selectOption('llc');
      await form.getByLabel(/^State/).fill('IL');
      await form.getByLabel(/Formation date/).fill('2019-06-03');
      await page.getByRole('button', { name: 'Add business' }).click();
      await expect(page.getByText('Business added.')).toBeVisible();
      const card = page.locator('section.card', { has: page.getByRole('heading', { name: 'Businesses' }) });
      await expect(card, 'her business is on the card').toContainText(name);
      await page.screenshot({ path: shot, fullPage: true });
      passed = true;
    } finally {
      if (!existsSync(shot)) await page.screenshot({ path: shot, fullPage: true }).catch(() => undefined);
      testInfo.annotations.push({ type: 'screenshot', description: keepScreenshot(`add-business-laura-${viewport}`, passed, shot) });
      testInfo.annotations.push({ type: 'walk-step', description: `A1|${CONTROL}|${ROLES}|tap` });
    }
  });

  test('role proof: the bookkeeper has no Add a business button and the route refuses her', async ({ page }, testInfo) => {
    await signIn(page, fixtures.wall.bookkeeper);
    await page.goto(`/clients/${fixtures.contactId}`);
    await expect(page.getByRole('heading', { name: 'Businesses' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add a business' }), 'the control is not on her page').toHaveCount(0);
    const status = await page.evaluate(async (id) => {
      const r = await fetch(`/api/contacts/${id}/businesses`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'HARNESS-BOOKKEEPER-REFUSED LLC', entityType: 'llc', state: 'IL' }) });
      return r.status;
    }, fixtures.contactId);
    expect(status, 'the route refuses a role holding neither contacts.write nor businesses.write').toBe(403);
    testInfo.annotations.push({ type: 'walk-step', description: `A1|role proof: bookkeeper sees no button, POST refused 403|${ROLES}|tap` });
  });
});
