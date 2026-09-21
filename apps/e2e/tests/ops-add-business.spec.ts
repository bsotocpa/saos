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
/** EDIT AFTER CREATE (2026-09-20): the same door as Add, on each business's row. */
const EDIT_CONTROL = '/clients/:id Businesses card, button "Edit" on the row, form#edit-business-form, button "Save business"';
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
      // One EIN per viewport: the same number twice is the same business to the route (refused), and both projects share the database.
      await form.getByLabel(/EIN/).fill(viewport === 'phone' ? '12-3456789' : '12-3456790');
      // CREATED WITH THE OPTIONAL FIELDS SKIPPED (2026-09-20): no formation date, no industry — they are filled in by editing below.
      await form.getByLabel(/Make this the primary business/).check();
      await page.getByRole('button', { name: 'Add business' }).click();
      await expect(page.getByText('Business added.')).toBeVisible();
      await expect(form).toHaveCount(0);
      const card = page.locator('section.card', { has: page.getByRole('heading', { name: 'Businesses' }) });
      await expect(card).toContainText(name);
      const row = card.locator('div.lead-card', { hasText: name }).first();
      await expect(row, 'the EIN is on the card').toContainText('EIN on file');
      await expect(row, 'it is the primary business').toContainText('primary');
      await expect(row, 'no formation date yet').not.toContainText('formed ');

      // ── EDIT AFTER CREATE: the formation date and the industry, through the row's Edit door.
      await row.getByRole('button', { name: 'Edit' }).click();
      const edit = page.locator('#edit-business-form');
      await expect(edit).toBeVisible();
      await expect(edit.getByLabel(/Legal name/), 'the form opens on the record').toHaveValue(name);
      // A formation date after today is refused by the route; the words land beside the date control and the text stays.
      await edit.getByLabel(/Formation date/).fill(plusDays(3));
      await edit.getByLabel(/Industry/).fill('professional_services');
      await page.getByRole('button', { name: 'Save business' }).click();
      const dateError = edit.locator('.field-error[data-field="formationDate"]');
      await expect(dateError, 'the refusal sits beside the formation date').toBeVisible();
      await expect(dateError, "with the server's words").toContainText('A formation date is a thing that already happened.');
      await expect(edit.getByLabel(/Industry/), 'the industry is still there').toHaveValue('professional_services');
      await edit.getByLabel(/Formation date/).fill('2020-01-15');
      await page.getByRole('button', { name: 'Save business' }).click();
      await expect(page.getByText('Business saved.')).toBeVisible();
      await expect(edit).toHaveCount(0);
      await expect(row, 'the formation date is on the card').toContainText('formed Jan 15, 2020');
      await expect(row, 'and the industry').toContainText('professional_services');
      await page.screenshot({ path: shot, fullPage: true });
      passed = true;
    } finally {
      if (!existsSync(shot)) await page.screenshot({ path: shot, fullPage: true }).catch(() => undefined);
      testInfo.annotations.push({ type: 'screenshot', description: keepScreenshot(`add-business-${viewport}`, passed, shot) });
      testInfo.annotations.push({ type: 'walk-step', description: `A1|${CONTROL}|${ROLES}|tap` });
      testInfo.annotations.push({ type: 'edit-door', description: `business|${EDIT_CONTROL}|${ROLES}|tap` });
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
      // Created without the formation date; she fills it in by editing, the way she would after a filing.
      await page.getByRole('button', { name: 'Add business' }).click();
      await expect(page.getByText('Business added.')).toBeVisible();
      const card = page.locator('section.card', { has: page.getByRole('heading', { name: 'Businesses' }) });
      await expect(card, 'her business is on the card').toContainText(name);
      const row = card.locator('div.lead-card', { hasText: name }).first();
      await row.getByRole('button', { name: 'Edit' }).click();
      const edit = page.locator('#edit-business-form');
      await expect(edit).toBeVisible();
      await edit.getByLabel(/Formation date/).fill('2019-06-03');
      await edit.getByLabel(/Industry/).fill('retail');
      await page.getByRole('button', { name: 'Save business' }).click();
      await expect(page.getByText('Business saved.')).toBeVisible();
      await expect(row, 'the formation date she entered is on the card').toContainText('formed Jun 3, 2019');
      await expect(row, 'and the industry').toContainText('retail');
      await page.screenshot({ path: shot, fullPage: true });
      passed = true;
    } finally {
      if (!existsSync(shot)) await page.screenshot({ path: shot, fullPage: true }).catch(() => undefined);
      testInfo.annotations.push({ type: 'screenshot', description: keepScreenshot(`add-business-laura-${viewport}`, passed, shot) });
      testInfo.annotations.push({ type: 'walk-step', description: `A1|${CONTROL}|${ROLES}|tap` });
      testInfo.annotations.push({ type: 'edit-door', description: `business|${EDIT_CONTROL}|${ROLES}|tap` });
    }
  });

  test('role proof: the bookkeeper has no Add a business button and the route refuses her', async ({ page }, testInfo) => {
    await signIn(page, fixtures.wall.bookkeeper);
    await page.goto(`/clients/${fixtures.contactId}`);
    await expect(page.getByRole('heading', { name: 'Businesses' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add a business' }), 'the control is not on her page').toHaveCount(0);
    const card = page.locator('section.card', { has: page.getByRole('heading', { name: 'Businesses' }) });
    await expect(card.locator('div.lead-card').first(), 'she reads the businesses').toBeVisible();
    await expect(card.getByRole('button', { name: 'Edit' }), 'and no row offers Edit').toHaveCount(0);
    const statuses = await page.evaluate(async (id) => {
      const post = await fetch(`/api/contacts/${id}/businesses`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'HARNESS-BOOKKEEPER-REFUSED LLC', entityType: 'llc', state: 'IL' }) });
      const list = (await (await fetch(`/api/contacts/${id}`)).json()) as { businesses: Array<{ id: string }> };
      const patch = await fetch(`/api/businesses/${list.businesses[0]!.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ industry: 'refused' }) });
      return { post: post.status, patch: patch.status };
    }, fixtures.contactId);
    expect(statuses.post, 'the create route refuses a role holding neither contacts.write nor businesses.write').toBe(403);
    expect(statuses.patch, 'and the edit route is the same door').toBe(403);
    testInfo.annotations.push({ type: 'walk-step', description: `A1|role proof: bookkeeper sees no button, POST refused 403|${ROLES}|tap` });
    testInfo.annotations.push({ type: 'edit-door', description: `business|role proof: bookkeeper sees no Edit on any row, PATCH /businesses/:id refused 403|${ROLES}|tap` });
  });
});
