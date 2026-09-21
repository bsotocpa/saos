/*
 * THE TWO ADDRESSES OF A MIGRATED CLIENT (Brian, 2026-09-20). A client who came over from the old
 * system signs in with the address their portal account was made on; the contact record carries
 * the corrected one. Every link the system emails goes to the contact address and a sign-in
 * request typed with it matches no account. On the client page: a warning line, and ONE control
 * that makes the sign-in address the contact email. Both viewports, through the real route; the
 * refusal when another account already signs in with that address renders in the server's own
 * words; the bookkeeper (no contacts.write) sees the warning and no control, and the route
 * refuses her.
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
  port?: number;
  staff: Persona;
  wall: { bookkeeper: Persona };
};
const API = `http://127.0.0.1:${fixtures.port ?? 3101}`;
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
const CONTROL = '/clients/:id Portal access line, button "Use the contact email for sign-in" → ask() modal, button "Use the contact email"';
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
async function staffToken(who: Persona = fixtures.staff): Promise<string> {
  const totp = new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(who.totpSecret) }).generate();
  const r = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: who.email, password: who.password, totp }) });
  expect(r.status, `${who.email} signs in on the harness API`).toBe(200);
  return ((await r.json()) as { token: string }).token;
}
async function asStaff<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch(`${API}${path}`, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(init.headers ?? {}) } });
  const body = (await r.json().catch(() => ({}))) as T;
  expect(r.status, `${init.method ?? 'GET'} ${path}: ${JSON.stringify(body)}`).toBeLessThan(300);
  return body;
}
function keepScreenshot(name: string, passed: boolean, file: string): string {
  const dir = passed ? resolve(here, '..', '.artifacts', today) : resolve(root, 'tasks', 'walks', today);
  mkdirSync(dir, { recursive: true });
  const target = resolve(dir, `${name}.png`);
  if (existsSync(file)) copyFileSync(file, target);
  return target;
}

/** A migrated client of this spec's own: a portal account on one synthetic address, the contact on another. */
async function migratedClient(token: string, tag: string): Promise<{ id: string; contactEmail: string; portalEmail: string }> {
  const contact = await asStaff<{ id: string }>(token, '/contacts', { method: 'POST', body: JSON.stringify({ firstName: 'Synthetic', lastName: `Twoaddr-${tag}`, email: `twoaddr-${tag}@example.test` }) });
  await asStaff(token, '/portal-users', { method: 'POST', body: JSON.stringify({ contactId: contact.id }) });
  const portalEmail = `twoaddr-${tag}-portal@example.test`;
  const contactEmail = `twoaddr-${tag}-contact@example.test`;
  await fetch(`${API}/harness/migrated-client`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ contactId: contact.id, portalEmail, contactEmail }) });
  return { id: contact.id, contactEmail, portalEmail };
}

test.describe('the portal sign-in address and the contact email', () => {
  test('the warning, the one control, and the refusal in the server\'s words', async ({ page }, testInfo) => {
    const viewport = testInfo.project.name;
    const shot = testInfo.outputPath(`ops-portal-email-${viewport}.png`);
    let passed = false;
    try {
      const token = await staffToken();
      const client = await migratedClient(token, `${viewport}-a`);
      await signIn(page, fixtures.staff);

      await page.goto(`/clients/${client.id}`);
      const warning = page.getByTestId('portal-email-mismatch');
      await expect(warning, 'the page says the two addresses differ').toBeVisible();
      await expect(warning).toContainText('The sign-in address is not the contact email.');
      await expect(page.getByText(client.portalEmail), 'and shows which address signs in').toBeVisible();
      await page.screenshot({ path: shot, fullPage: true });

      // THE REFUSAL FIRST: another portal account already signs in with this contact's email.
      const other = await migratedClient(token, `${viewport}-b`);
      await asStaff(token, `/contacts/${client.id}`, { method: 'PATCH', body: JSON.stringify({ email: other.portalEmail }) });
      await page.reload();
      await expect(page.getByTestId('portal-email-mismatch')).toBeVisible();
      await page.getByTestId('align-portal-email').click();
      const modal = page.locator('[role=dialog]');
      await expect(modal.getByRole('heading', { name: 'Use the contact email for sign-in?' })).toBeVisible();
      await modal.getByRole('button', { name: 'Use the contact email' }).click();
      await expect(modal.locator('#ask-error'), 'the server\'s refusal, verbatim, under the control').toHaveText(
        'Another portal account already signs in with the contact email. Change one of the two addresses first.'
      );
      await modal.getByRole('button', { name: 'Cancel' }).click();
      await expect(modal).toHaveCount(0);

      // Then the contact email is put back to its own, and the control does what it says.
      await asStaff(token, `/contacts/${client.id}`, { method: 'PATCH', body: JSON.stringify({ email: client.contactEmail }) });
      await page.reload();
      await expect(page.getByTestId('portal-email-mismatch')).toBeVisible();
      await page.getByTestId('align-portal-email').click();
      await page.locator('[role=dialog]').getByRole('button', { name: 'Use the contact email' }).click();
      await expect(page.getByText('The sign-in address is now the contact email.')).toBeVisible();
      await expect(page.getByTestId('portal-email-mismatch'), 'the warning is gone').toHaveCount(0);
      await expect(page.getByTestId('align-portal-email'), 'and so is the control').toHaveCount(0);
      await expect(page.getByText(client.contactEmail).first(), 'the page reads the contact email as the sign-in address').toBeVisible();

      passed = true;
    } finally {
      if (!existsSync(shot)) await page.screenshot({ path: shot, fullPage: true }).catch(() => undefined);
      testInfo.annotations.push({ type: 'screenshot', description: keepScreenshot(`ops-portal-email-${viewport}`, passed, shot) });
      testInfo.annotations.push({ type: 'walk-step', description: `E3|${CONTROL} at ${viewport}: the warning line, the refusal in the server's words when another account holds the address, then the alignment and the warning gone|${ROLES}|tap` });
    }
  });

  test('role proof: the bookkeeper reads the warning, has no control, and the route refuses her', async ({ page }, testInfo) => {
    const viewport = testInfo.project.name;
    const token = await staffToken();
    const client = await migratedClient(token, `${viewport}-c`);
    await signIn(page, fixtures.wall.bookkeeper);
    await page.goto(`/clients/${client.id}`);
    await expect(page.getByTestId('portal-email-mismatch'), 'she reads that the addresses differ').toBeVisible();
    await expect(page.getByTestId('align-portal-email'), 'and has no control to change it').toHaveCount(0);
    const status = await page.evaluate(async (id) => (await fetch(`/api/contacts/${id}/align-portal-email`, { method: 'POST' })).status, client.id);
    expect(status, 'the route refuses a role without contacts.write').toBe(403);
    testInfo.annotations.push({ type: 'walk-step', description: `E3|role proof: bookkeeper sees the warning and no "Use the contact email for sign-in" control, POST /contacts/:id/align-portal-email refused 403|${ROLES}|tap` });
  });
});
