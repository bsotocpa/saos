/*
 * THE CONTACT EMAIL CHANGES, THE SIGN-IN FOLLOWS WHEN THE NEW ADDRESS SAYS SO (Brian, 2026-09-26, R45)
 * — walk step P1, at 390 × 844 and 1280 × 800.
 *
 * On a client of this spec's own (a contact with portal access on its email, both synthetic), the CEO
 * edits the email on the client page. Saving asks, in the modal, whether to move the portal sign-in
 * too; "Save and move the sign-in" saves the email, sends ONE confirmation link to the new address and
 * leaves the sign-in where it was. The client page reads "Sign-in move pending confirmation" and
 * offers Resend. The link is read from the harness mailer (never assembled), opened on the portal:
 * a bare load spends nothing (the Ops page still reads pending); the button press moves the sign-in,
 * the pending line is gone and the page reads the new address as the one that signs in.
 */
import { expect, test, type Page } from '@playwright/test';
import * as OTPAuth from 'otpauth';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { viewportKey } from './viewport';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..');
interface Persona { email: string; password: string; totpSecret: string }
const fixtures = JSON.parse(readFileSync(resolve(here, '..', process.env.E2E_ARTIFACTS ?? '.artifacts', 'fixtures.json'), 'utf8')) as {
  port?: number; portalPort?: number;
  staff: Persona;
};
const API = `http://127.0.0.1:${fixtures.port ?? 3101}`;
const PORTAL = `http://localhost:${fixtures.portalPort ?? 3106}`;
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
const CONTROL = '/clients/:id Contact card, button "Edit", input Email, button "Save" → ask() modal "Also move the portal sign-in to this address?", button "Save and move the sign-in"; Portal access line "Sign-in move pending confirmation", button "Resend the confirmation link"; portal /auth/confirm-email button "Use this email to sign in"';
const ROLES = 'ceo, comms_billing (contacts.write); the client (the link in the new inbox)';

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
async function mailLinks(): Promise<{ confirmLinks: string[]; confirmTokens: string[] }> {
  return (await (await fetch(`${API}/harness/mail-links`)).json()) as { confirmLinks: string[]; confirmTokens: string[] };
}
function keepScreenshot(name: string, passed: boolean, file: string): string {
  const dir = passed ? resolve(here, '..', '.artifacts', today) : resolve(root, 'tasks', 'walks', today);
  mkdirSync(dir, { recursive: true });
  const target = resolve(dir, `${name}.png`);
  if (existsSync(file)) copyFileSync(file, target);
  return target;
}

test.describe('the contact email changes and the sign-in follows once the new address confirms', () => {
  test('P1: the offer in the modal, the pending line and Resend, the link pressed on the portal', async ({ page }, testInfo) => {
    const viewport = viewportKey(testInfo);
    const shot = testInfo.outputPath(`ops-portal-email-move-${viewport}.png`);
    let passed = false;
    try {
      const token = await staffToken();
      const oldEmail = `emailmove-${viewport}@example.test`;
      const newEmail = `emailmove-${viewport}-new@example.test`;
      const contact = await asStaff<{ id: string }>(token, '/contacts', { method: 'POST', body: JSON.stringify({ firstName: 'Synthetic', lastName: `Emailmove-${viewport}`, email: oldEmail }) });
      await asStaff(token, '/portal-users', { method: 'POST', body: JSON.stringify({ contactId: contact.id }) });
      const linksBefore = (await mailLinks()).confirmLinks.length;

      await signIn(page, fixtures.staff);
      await page.goto(`/clients/${contact.id}`);
      await expect(page.getByText(oldEmail).first(), 'the portal access line reads the address that signs in').toBeVisible();

      // THE EDIT: the email changes; Save asks about the sign-in in its own modal.
      const contactCard = page.locator('section.card', { has: page.getByRole('heading', { name: /^Contact/ }) });
      await contactCard.getByTestId('edit-contact').click();
      await contactCard.getByLabel(/^Email/).fill(newEmail);
      await contactCard.getByRole('button', { name: 'Save' }).click();
      const modal = page.locator('[role=dialog]');
      await expect(modal.getByRole('heading', { name: 'Also move the portal sign-in to this address?' })).toBeVisible();
      await expect(modal, 'the modal names the address that signs in today').toContainText(oldEmail);
      await modal.getByRole('button', { name: 'Save and move the sign-in' }).click();
      await expect(page.getByText('Saved. A confirmation link was sent to the new address; the sign-in moves when the client presses it.')).toBeVisible();

      // THE PENDING LINE: the sign-in has NOT moved; the client page says so and offers Resend.
      const pending = page.getByTestId('portal-email-move-pending');
      await expect(pending).toBeVisible();
      await expect(pending).toContainText('Sign-in move pending confirmation');
      await expect(pending).toContainText(newEmail);
      await expect(page.getByText(new RegExp(`signs in as .*${oldEmail.replace('.', '\\.')}`)), 'the sign-in is still the old address').toBeVisible();
      await page.screenshot({ path: shot, fullPage: true });
      let links = await mailLinks();
      expect(links.confirmLinks.length, 'exactly one confirmation link reached the mailer').toBe(linksBefore + 1);

      // RESEND: one more link, the earlier one retired.
      await page.getByTestId('resend-portal-email-move').click();
      await page.locator('[role=dialog]').getByRole('button', { name: 'Send the link' }).click();
      await expect(page.getByText('Another confirmation link is on its way to the new address.')).toBeVisible();
      links = await mailLinks();
      expect(links.confirmLinks.length).toBe(linksBefore + 2);
      const href = links.confirmLinks[links.confirmLinks.length - 1]!;
      expect(href.startsWith(`${PORTAL}/auth/confirm-email?token=`), 'the emailed href points at the harness portal').toBe(true);

      // A BARE LOAD SPENDS NOTHING (the R37 rule): open the link, come back, still pending.
      await page.goto(href);
      await expect(page.getByTestId('confirm-email-press')).toBeVisible();
      await page.goto(`/clients/${contact.id}`);
      await expect(page.getByTestId('portal-email-move-pending'), 'the load changed nothing').toBeVisible();

      // THE PRESS moves the sign-in.
      await page.goto(href);
      await page.getByTestId('confirm-email-press').click();
      await expect(page.getByTestId('confirm-email-done')).toHaveText('Done. From now on, sign in with this email address.');
      await page.goto(`/clients/${contact.id}`);
      await expect(page.getByTestId('portal-email-move-pending'), 'nothing is pending any more').toHaveCount(0);
      await expect(page.getByText(new RegExp(`signs in as .*${newEmail.replace(/\./g, '\\.')}`)), 'the new address signs in').toBeVisible();
      await expect(page.getByTestId('portal-email-mismatch'), 'and it is the contact email, so no warning').toHaveCount(0);

      // The retired link is dead: the press on it fails in the portal's words.
      const stale = links.confirmLinks[links.confirmLinks.length - 2]!;
      await page.goto(stale);
      await page.getByTestId('confirm-email-press').click();
      // The page's own alert, not Next's route announcer (which is also role=alert).
      await expect(page.locator('p.alert.error[role=alert]')).toContainText('This link is invalid, used, or expired.');
      passed = true;
    } finally {
      if (!existsSync(shot)) await page.screenshot({ path: shot, fullPage: true }).catch(() => undefined);
      testInfo.annotations.push({ type: 'screenshot', description: keepScreenshot(`ops-portal-email-move-${viewport}`, passed, shot) });
      testInfo.annotations.push({ type: 'walk-step', description: `P1|${CONTROL} at ${viewport}: the offer in the Save modal, the pending line with the new address, Resend, the emailed link opened (nothing spent) then pressed (the sign-in moved, the warning absent)|${ROLES}|tap` });
    }
  });
});
