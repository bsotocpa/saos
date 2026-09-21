/*
 * WALK STEP B1, ADD A CLIENT (Brian, ruling R14, 2026-09-20).
 *
 * /clients could search 426 records and create none of them: a new client arrived by seed, by
 * import, or by curl. The control is on the directory, under contacts.write, and the duplicate check
 * is built into the door — so the harness proves both halves at 390 and 1280: the CEO adds a
 * synthetic person and lands on the record, then types the SAME person again and reads the warning
 * with a link to the record she already has, with nothing created behind it (asserted through a
 * read, not by looking at the screen).
 *
 * The role proof is the bookkeeper, who holds no contacts.write: no button on the directory, and the
 * route refuses her POST. Rene (comms_billing) holds it and would see the button; the CEO by wildcard.
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
  wall: { bookkeeper: Persona };
};
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
const CONTROL = '/clients button "Add a client", form#add-client-form, duplicate warning with link, button "Add client"';
/** EDIT AFTER CREATE (2026-09-20): the optional fields skipped at Add are filled in on the record. */
const EDIT_CONTROL = '/clients/:id Contact card, button "Edit", inputs Email and Phone, button "Save"';
const ROLES = 'ceo, comms_billing (contacts.write)';

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
/** How many non-archived records the directory holds under this name. The read, not the screen. */
async function countByName(page: Page, search: string): Promise<number> {
  return page.evaluate(async (q) => {
    const r = await fetch(`/api/contacts?search=${encodeURIComponent(q)}`);
    const j = (await r.json()) as { total?: number };
    return j.total ?? -1;
  }, search);
}

test.describe('Add a client from the directory', () => {
  test('the CEO adds a synthetic person, then types the same person again and reads the duplicate before anything is created', async ({ page }, testInfo) => {
    const viewport = testInfo.project.name;
    const shot = testInfo.outputPath(`add-client-${viewport}.png`);
    // A distinct person per viewport: both projects run against the same harness database.
    const lastName = `Addclient-${viewport.charAt(0).toUpperCase()}${viewport.slice(1)}`;
    const fullName = `Synthetic ${lastName}`;
    const email = `addclient-${viewport}@example.test`;
    const phone = viewport === 'phone' ? '(312) 555-0781' : '(312) 555-0782';
    let passed = false;
    try {
      await signIn(page, fixtures.staff);
      await page.goto('/clients');
      await expect(page.getByRole('heading', { name: 'Clients' })).toBeVisible();

      // ── The first one: added, and the browser lands on the new record.
      await page.getByRole('button', { name: 'Add a client' }).click();
      const form = page.locator('#add-client-form');
      await expect(form).toBeVisible();
      await form.getByLabel(/First name/).fill('Synthetic');
      await form.getByLabel(/Last name/).fill(lastName);
      // CREATED WITH THE OPTIONAL FIELDS SKIPPED (2026-09-20): no email, no phone — filled in by editing the record below.
      await form.getByLabel(/Language/).selectOption('es');
      await page.getByRole('button', { name: 'Add client' }).click();
      await page.waitForURL(/\/clients\/[0-9a-f-]{36}$/);
      const createdId = page.url().split('/').pop()!;
      await expect(page.getByRole('heading', { name: fullName })).toBeVisible();
      expect(await countByName(page, lastName), 'one record under that name').toBe(1);

      // ── EDIT AFTER CREATE: the email and the phone, through the contact card's Edit door.
      const contactCard = page.locator('section.card', { has: page.getByRole('heading', { name: /^Contact/ }) });
      await expect(contactCard.getByTestId('missing-line'), 'the record says what is missing').toContainText('email');
      await contactCard.getByTestId('edit-contact').click();
      await contactCard.getByLabel(/^Email/).fill(email);
      await contactCard.getByLabel(/^Phone/).fill(phone);
      await contactCard.getByRole('button', { name: 'Save' }).click();
      await expect(page.getByText('Saved.')).toBeVisible();
      await expect(contactCard, 'the email is on the card').toContainText(email);
      await expect(contactCard.getByTestId('missing-line'), 'and it is no longer missing').toHaveCount(0);
      testInfo.annotations.push({ type: 'edit-door', description: `contact|${EDIT_CONTROL}|${ROLES}|tap` });

      // ── The same person again: the warning, with a link to the record she already has.
      await page.goto('/clients');
      await page.getByRole('button', { name: 'Add a client' }).click();
      await expect(form).toBeVisible();
      await form.getByLabel(/First name/).fill('Synthetic');
      await form.getByLabel(/Last name/).fill(lastName);
      await form.getByLabel(/Email/).fill(email);
      await form.getByLabel(/Phone/).fill(phone);
      const warning = form.locator('[data-testid="duplicate-warning"]');
      await expect(warning, 'the duplicate renders inside the modal').toBeVisible();
      await expect(warning, "with the server's words").toContainText('the same name, the same email address and the same phone number');
      const link = warning.getByRole('link', { name: fullName });
      await expect(link, 'with a link to the record').toHaveAttribute('href', `/clients/${createdId}`);
      await expect(warning.getByRole('button', { name: 'Create anyway' }), 'creating anyway is its own tap').toBeVisible();
      await page.screenshot({ path: shot, fullPage: true });

      // Nothing was created by the warning, and pressing Add client again does not create either.
      await page.getByRole('button', { name: 'Add client' }).click();
      await expect(warning).toBeVisible();
      expect(await countByName(page, lastName), 'still one record: the warning created nothing').toBe(1);
      passed = true;
    } finally {
      if (!existsSync(shot)) await page.screenshot({ path: shot, fullPage: true }).catch(() => undefined);
      testInfo.annotations.push({ type: 'screenshot', description: keepScreenshot(`add-client-${viewport}`, passed, shot) });
      testInfo.annotations.push({ type: 'walk-step', description: `B1|${CONTROL}|${ROLES}|tap` });
    }
  });

  test('role proof: the bookkeeper has no Add a client button and the route refuses her', async ({ page }, testInfo) => {
    await signIn(page, fixtures.wall.bookkeeper);
    await page.goto('/clients');
    await expect(page.getByRole('heading', { name: 'Clients' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add a client' }), 'the control is not on her page').toHaveCount(0);
    const statuses = await page.evaluate(async () => {
      const post = await fetch('/api/contacts', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ firstName: 'Synthetic', lastName: 'Refusedbookkeeper' }),
      });
      const check = await fetch('/api/contacts/duplicate-check?firstName=Synthetic&lastName=Refusedbookkeeper');
      return { post: post.status, check: check.status };
    });
    expect(statuses.post, 'the route refuses a role holding no contacts.write').toBe(403);
    expect(statuses.check, 'the duplicate check is the same door').toBe(403);
    testInfo.annotations.push({ type: 'walk-step', description: `B1|role proof: bookkeeper has no button, POST /contacts 403|${ROLES}|tap` });

    // The edit door is the same grant: no Edit on the contact card she can read, and the PATCH refuses her.
    await page.goto(`/clients/${fixtures.contactId}`);
    await expect(page.getByRole('heading', { name: /^Contact/ })).toBeVisible();
    await expect(page.getByTestId('edit-contact'), 'no Edit on her contact card').toHaveCount(0);
    const patch = await page.evaluate(async (id) => (await fetch(`/api/contacts/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone: '(312) 555-0999' }) })).status, fixtures.contactId);
    expect(patch, 'PATCH /contacts/:id refuses a role holding no contacts.write').toBe(403);
    testInfo.annotations.push({ type: 'edit-door', description: `contact|role proof: bookkeeper sees no Edit on the contact card, PATCH /contacts/:id refused 403|${ROLES}|tap` });
  });
});
