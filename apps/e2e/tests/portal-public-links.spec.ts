/*
 * THE EMAILED LINK OPENS WHAT IT NAMES (Brian, 2026-09-20). Two things a person met on the real
 * portal, proven at both viewports on a migrated client — a portal account on one address, the
 * contact record on another:
 *
 *   1. A proposal link renders its quote for the recipient with no session needed. The failing
 *      shape: a "signed in" marker left in the browser by a session that has since lapsed sent the
 *      reader to the sign-in request page before the proposal drew. Here the client signs in once,
 *      every session of theirs is lapsed by the harness door, the marker stays, and the emailed
 *      href — read from the harness mailer, never assembled — must show the proposal.
 *
 *   2. A sign-in link is spent by a button press, not by a load. The page is opened with the
 *      href as emailed and the link must still be unused; the press signs the person in.
 *
 * The client is this spec's own, made through the same doors a staffer uses (contact, grant access),
 * then migrated by the harness's own SQL door, so nothing the walks rely on is touched.
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
  port?: number; portalPort?: number;
  staff: Persona;
  /** The individual 1040 base line: business work needs a business on the quote, and this client has none. */
  pathB: { item: { code: string } };
};
const API = `http://127.0.0.1:${fixtures.port ?? 3101}`;
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());

test.use({ baseURL: `http://localhost:${fixtures.portalPort ?? 3106}` });

async function staffToken(): Promise<string> {
  const totp = new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(fixtures.staff.totpSecret) }).generate();
  const r = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: fixtures.staff.email, password: fixtures.staff.password, totp }) });
  expect(r.status, 'the staff member signs in on the harness API').toBe(200);
  return ((await r.json()) as { token: string }).token;
}
async function asStaff<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch(`${API}${path}`, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(init.headers ?? {}) } });
  const body = (await r.json().catch(() => ({}))) as T;
  expect(r.status, `${init.method ?? 'GET'} ${path}: ${JSON.stringify(body)}`).toBeLessThan(300);
  return body;
}
async function mailLinks(): Promise<{ magicLinks: string[]; quoteLinks: string[]; magicTokens: string[] }> {
  return (await (await fetch(`${API}/harness/mail-links`)).json()) as { magicLinks: string[]; quoteLinks: string[]; magicTokens: string[] };
}
async function harness<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${API}${path}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return (await r.json()) as T;
}
function keepScreenshot(name: string, passed: boolean, file: string): string {
  const dir = passed ? resolve(here, '..', '.artifacts', today) : resolve(root, 'tasks', 'walks', today);
  mkdirSync(dir, { recursive: true });
  const target = resolve(dir, `${name}.png`);
  if (existsSync(file)) copyFileSync(file, target);
  return target;
}

/** A migrated client of this spec's own, and the sign-in href the grant emailed them. */
async function migratedClient(token: string, tag: string): Promise<{ contactId: string; signInHref: string }> {
  const before = (await mailLinks()).magicLinks.length;
  const contact = await asStaff<{ id: string }>(token, '/contacts', { method: 'POST', body: JSON.stringify({ firstName: 'Synthetic', lastName: `Migrated-${tag}`, email: `migrated-${tag}@example.test` }) });
  await asStaff(token, '/portal-users', { method: 'POST', body: JSON.stringify({ contactId: contact.id }) });
  const links = (await mailLinks()).magicLinks.slice(before);
  expect(links.length, 'the grant emailed a sign-in link').toBeGreaterThan(0);
  await harness('/harness/migrated-client', { contactId: contact.id, portalEmail: `migrated-${tag}-portal@example.test`, contactEmail: `migrated-${tag}-contact@example.test` });
  return { contactId: contact.id, signInHref: links[links.length - 1]! };
}

async function pressSignIn(page: Page, href: string): Promise<void> {
  await page.goto(href);
  await page.getByTestId('verify-press').click();
  await page.waitForURL((u) => new URL(u).pathname === '/');
}

test.describe('the emailed link opens what it names', () => {
  test('a proposal link renders its quote with a stale signed-in marker and no session', async ({ page }, testInfo) => {
    const viewport = testInfo.project.name;
    const shot = testInfo.outputPath(`portal-public-quote-${viewport}.png`);
    let passed = false;
    try {
      const token = await staffToken();
      const client = await migratedClient(token, `quote-${viewport}`);

      // Signed in once, the way the client does it: the emailed href, then the button.
      await pressSignIn(page, client.signInHref);
      await expect(page.getByTestId('sign-out')).toBeVisible();

      /*
       * Every session lapses. A phone that comes back a month later still holds the "signed in"
       * marker with a dead session behind it — that is the state the real portal was in. The
       * harness home page is not that phone: a fetch of its own that lands after the lapse gets
       * a 401 on a non-public path and clears the marker, which is the app being right. So the
       * marker is put back by hand here, the way a month of absence leaves it.
       */
      const lapsed = await harness<{ expired: number }>('/harness/portal-sessions/expire', { contactId: client.contactId });
      expect(lapsed.expired, 'the session the press created is the one that lapses').toBeGreaterThan(0);
      // The home page's own next fetch meets the dead session and sends itself to /login (a non-public
      // path: that is the app being right); a goto racing that redirect is aborted, so the arrival is waited for.
      await page.goto('/login').catch(() => undefined);
      await page.waitForURL((u) => new URL(u).pathname === '/login');
      // The sign-in request page must have MOUNTED with no marker before one is planted: planted
      // earlier, its own session check meets the dead session and its redirect collides with the
      // proposal navigation below (the desk browser lost that race once). Settled, it fetches nothing more.
      await page.waitForLoadState('networkidle');
      await page.evaluate(() => localStorage.removeItem('saos_portal_authed'));
      await page.waitForTimeout(500);
      const dead = await page.evaluate(async () => (await fetch('/api/portal/me')).status);
      expect(dead, 'the session behind the marker is dead').toBe(401);
      await page.evaluate(() => localStorage.setItem('saos_portal_authed', '1'));

      // A proposal is sent to the CONTACT address through the real send; its href comes out of the mailer.
      const linksBefore = (await mailLinks()).quoteLinks.length;
      const quote = await asStaff<{ id: string }>(token, '/quotes', { method: 'POST', body: JSON.stringify({ contactId: client.contactId, language: 'en', lines: [{ itemCode: fixtures.pathB.item.code }] }) });
      await asStaff(token, `/quotes/${quote.id}/send`, { method: 'POST', body: JSON.stringify({}) });
      const fresh = (await mailLinks()).quoteLinks.slice(linksBefore);
      expect(fresh.length, 'the proposal email reached the harness mailer with its link').toBeGreaterThan(0);

      await page.goto(fresh[fresh.length - 1]!);
      await expect(page.getByRole('heading', { name: 'Your proposal' }), 'the proposal renders for the recipient').toBeVisible();
      expect(new URL(page.url()).pathname.startsWith('/quote/'), 'and the browser was not sent to the sign-in request page').toBe(true);
      await expect(page.getByRole('button', { name: 'Accept and start the work' })).toBeVisible();
      // The redirect, when it fires, fires after the session check answers — later than the heading.
      // The page has to STAY: a proposal that draws and is then replaced is the failure being guarded.
      await page.waitForTimeout(1500);
      expect(new URL(page.url()).pathname.startsWith('/quote/'), 'and stays on the proposal once the session check has answered').toBe(true);
      await expect(page.getByRole('heading', { name: 'Your proposal' })).toBeVisible();
      expect(await page.evaluate(() => localStorage.getItem('saos_portal_authed')), 'the stale marker was cleared silently').toBeNull();
      await page.screenshot({ path: shot, fullPage: true });
      passed = true;
    } finally {
      if (!existsSync(shot)) await page.screenshot({ path: shot, fullPage: true }).catch(() => undefined);
      testInfo.annotations.push({ type: 'screenshot', description: keepScreenshot(`portal-public-quote-${viewport}`, passed, shot) });
      testInfo.annotations.push({ type: 'walk-step', description: `E1|portal /quote/:token at ${viewport}, followed from the emailed href with a lapsed session and the browser's stale signed-in marker: heading "Your proposal" and button "Accept and start the work"|client (the emailed proposal link)|tap` });
    }
  });

  test('a sign-in link is spent by the button, not by the load', async ({ page }, testInfo) => {
    const viewport = testInfo.project.name;
    const shot = testInfo.outputPath(`portal-verify-press-${viewport}.png`);
    let passed = false;
    try {
      const token = await staffToken();
      const client = await migratedClient(token, `press-${viewport}`);
      const magicToken = new URL(client.signInHref).searchParams.get('token')!;

      // The bare load, JavaScript and all: the page draws, the link stays whole.
      await page.goto(client.signInHref);
      await expect(page.getByTestId('verify-press')).toBeVisible();
      await page.waitForTimeout(800);
      const afterLoad = await harness<{ found: boolean; used: boolean | null }>(`/harness/magic-link/${magicToken}`);
      expect(afterLoad.found, 'the link is one the API issued').toBe(true);
      expect(afterLoad.used, 'loading the page spent nothing').toBe(false);
      await page.screenshot({ path: shot, fullPage: true });

      // The press: spent, and signed in.
      await page.getByTestId('verify-press').click();
      await page.waitForURL((u) => new URL(u).pathname === '/');
      await expect(page.getByTestId('sign-out')).toBeVisible();
      const afterPress = await harness<{ used: boolean | null }>(`/harness/magic-link/${magicToken}`);
      expect(afterPress.used, 'the press spent the link').toBe(true);

      // And a second load of the same href is refused in the page's own words, with a way back.
      await page.goto(client.signInHref);
      await page.getByTestId('verify-press').click();
      await expect(page.getByText('This link is invalid, used, or expired.')).toBeVisible();
      passed = true;
    } finally {
      if (!existsSync(shot)) await page.screenshot({ path: shot, fullPage: true }).catch(() => undefined);
      testInfo.annotations.push({ type: 'screenshot', description: keepScreenshot(`portal-verify-press-${viewport}`, passed, shot) });
      testInfo.annotations.push({ type: 'walk-step', description: `E2|portal /auth/verify?token= at ${viewport}, followed from the emailed href: the load leaves used_at null, button "Sign in" spends the link and signs the client in|client (the emailed sign-in link)|tap` });
    }
  });
});
