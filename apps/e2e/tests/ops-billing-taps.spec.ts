/*
 * TWO DOORS, TAPPED (Brian, ruling R17, 2026-09-20) — path D, at 390 × 844 and 1280 × 800.
 *
 * D1 — VOID. An invoice that should never be paid is retired from the client page: a reason (it is
 * the record), the number retained, the client told their pay link is dead. The row afterwards has
 * to say what happened and WHO did it, because "void" with no reason and no actor is how a money
 * decision becomes a mystery. So the assertion is the rendered row, not the API's answer.
 *
 * D2 — THE TEST-CLIENT FLAG. `contacts.is_test` decides whether a record counts: the directory
 * badge, the pipeline board, every report, dashboard, health score, funder metric and broadcast
 * audience read it. Nothing in Ops could SET it — the only writer is POST /contacts/:id/archive,
 * which takes `isTest` + `testNote` — so this ruling added the control and this is its tap.
 *
 * WHAT D2 CANNOT ASSERT, AND WHY IT IS SPLIT IN TWO. Flagging archives in the same act, and an
 * archived contact is refused by GET /contacts/:id and filtered out of the directory, the pipeline
 * board and the duplicate scan. So the TEST badge cannot be read on the record that was just
 * flagged — not because the flag did not land, but because the record is gone from Ops. The tap
 * therefore proves the WRITE from the route's own answer (the page states `isTest` as the server
 * returned it, never as a claim), and the badge is asserted where a flagged record is still
 * readable: the harness client, which e2e-boot flags is_test. Same `c.is_test`, same badge, one
 * fact proven in two places instead of one place pretending. The gap is in the 2026-09-20 report.
 *
 * Both tests create their own subject per viewport: the two projects run sequentially against ONE
 * harness database, so a spec that consumed a shared fixture would pass on the phone and find
 * nothing left on the desk.
 *
 * ROLE PROOF: the bookkeeper holds neither billing.manage nor contacts.write. Neither control is on
 * her page and both routes refuse her.
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
  port: number;
  contactId: string;
  staff: Persona;
  scorp: { invoiceItemCode: string };
  wall: { bookkeeper: Persona };
};
const API = `http://localhost:${fixtures.port}`;
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());

const VOID_CONTROL = '/clients/:id Invoices card, button "Void…" → ask() modal, textarea, button "Void invoice"';
const VOID_ROLES = 'ceo, comms_billing (billing.manage)';
const FLAG_CONTROL = '/clients/:id header, button "Flag as a test record…" → ask() modal, textarea, button "Flag as a test record"';
const FLAG_ROLES = 'ceo, comms_billing (contacts.write)';

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

/** A staff bearer token straight from the harness API, for the setup this spec does not tap. */
async function staffToken(who: Persona = fixtures.staff): Promise<string> {
  const totp = new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(who.totpSecret) }).generate();
  const r = await fetch(`${API}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: who.email, password: who.password, totp }),
  });
  expect(r.status, `${who.email} signs in on the harness API`).toBe(200);
  return ((await r.json()) as { token: string }).token;
}
async function asStaff<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch(`${API}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
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

test.describe('Ops → the void and test-client doors', () => {
  test('D1: the CEO voids a sent invoice and the row says why and who', async ({ page }, testInfo) => {
    const viewport = testInfo.project.name;
    const shot = testInfo.outputPath(`void-invoice-${viewport}.png`);
    const reason = `harness walk ${viewport}: superseded deposit, never to be paid`;
    let passed = false;
    try {
      /*
       * A SENT INVOICE OF THIS SPEC'S OWN. e2e-boot leaves the harness client one deposit invoice
       * already sent, and D1 would consume it — leaving the second viewport with nothing to void and
       * a failure that reads like a broken control. So the subject is issued here, priced from the
       * price book by item code (never an amount), and `send: true` puts it in the voidable state.
       */
      const token = await staffToken();
      const issued = await asStaff<{ id: string; invoiceNumber: string; totalCents: number }>(token, '/invoices', {
        method: 'POST',
        body: JSON.stringify({ contactId: fixtures.contactId, lines: [{ code: fixtures.scorp.invoiceItemCode }], send: true }),
      });
      expect(issued.totalCents, 'the price book gave the line an amount').toBeGreaterThan(0);
      const me = await asStaff<{ fullName: string }>(token, '/auth/me');

      await signIn(page, fixtures.staff);
      await page.goto(`/clients/${fixtures.contactId}`);
      await expect(page.getByRole('heading', { name: /Invoices \(/ })).toBeVisible();

      // Scoped to the Invoices card's own rows: the number appears in a send-log line too.
      const invoicesCard = page.locator('section.card', { has: page.getByRole('heading', { name: /Invoices \(/ }) });
      const row = invoicesCard.locator('ul.list > li', { hasText: issued.invoiceNumber });
      await expect(row, 'the issued invoice is on the client page').toBeVisible();
      await expect(row.locator('.badge').first(), "and it reads open, the portal's word for sent").toHaveText('Open');

      // A real tap: scrolled into view, hit-tested, refused if anything covers it.
      await row.getByRole('button', { name: 'Void…' }).click();
      const modal = page.locator('[role=dialog]');
      await expect(modal).toBeVisible();
      await expect(modal.getByRole('heading', { name: `Void ${issued.invoiceNumber}?` })).toBeVisible();
      // The reason is the record: the action is unreachable until it is written.
      await expect(modal.getByRole('button', { name: 'Void invoice' })).toBeDisabled();
      await modal.locator('textarea').fill(reason);
      await modal.getByRole('button', { name: 'Void invoice' }).click();
      await expect(modal).toHaveCount(0);

      await expect(page.getByText(`${issued.invoiceNumber} is void.`), 'the page says what happened').toBeVisible();
      /*
       * The ROW, re-read after the reload the handler triggers. `void · reason · actor · date`
       * (lib/invoice-display.ts) with the badge reading the word, never the enum.
       */
      const voided = invoicesCard.locator('ul.list > li', { hasText: issued.invoiceNumber });
      await expect(voided.locator('.badge').first(), 'the badge reads the word, not the enum').toHaveText('Cancelled');
      const line = voided.locator('.invoice-meta .muted.small').first();
      await expect(line, 'the void line carries the reason').toContainText(reason);
      await expect(line, 'and the actor, as a name').toContainText(me.fullName);
      await expect(line, 'never an email address').not.toContainText('@');

      await page.screenshot({ path: shot, fullPage: true });
      passed = true;
    } finally {
      if (!existsSync(shot)) await page.screenshot({ path: shot, fullPage: true }).catch(() => undefined);
      testInfo.annotations.push({ type: passed ? 'artifact' : 'failure-screenshot', description: keepScreenshot(`void-invoice-${viewport}`, passed, shot) });
      testInfo.annotations.push({ type: 'walk-step', description: `D1|${VOID_CONTROL}|${VOID_ROLES}|tap` });
    }
  });

  test('D2: the CEO flags a contact as a test record, and a flagged record wears the TEST badge', async ({ page }, testInfo) => {
    const viewport = testInfo.project.name;
    const shot = testInfo.outputPath(`test-client-flag-${viewport}.png`);
    const lastName = `Testflag-${viewport}`;
    const note = `harness walk ${viewport}: a rehearsal of the flag control, never a real person`;
    let passed = false;
    try {
      const token = await staffToken();
      const throwaway = await asStaff<{ id: string }>(token, '/contacts', {
        method: 'POST',
        body: JSON.stringify({ firstName: 'Synthetic', lastName }),
      });

      await signIn(page, fixtures.staff);
      await page.goto(`/clients/${throwaway.id}`);
      await expect(page.getByRole('heading', { name: `Synthetic ${lastName}` })).toBeVisible();
      await expect(page.getByText('TEST CLIENT — not a real engagement.'), 'it is not a test record yet').toHaveCount(0);

      await page.getByRole('button', { name: 'Flag as a test record…' }).click();
      const modal = page.locator('[role=dialog]');
      await expect(modal).toBeVisible();
      await expect(modal.getByRole('heading', { name: `Flag Synthetic ${lastName} as a test record?` })).toBeVisible();
      // The note is what the test WAS; the route requires it and the control cannot proceed without it.
      await expect(modal.getByRole('button', { name: 'Flag as a test record' })).toBeDisabled();
      await modal.locator('textarea').fill(note);
      await modal.getByRole('button', { name: 'Flag as a test record' }).click();
      await expect(modal).toHaveCount(0);

      // The route's own answer, rendered: `isTest` came back true from the call that wrote the column.
      const result = page.locator('[data-test-flagged="1"]');
      await expect(result, 'the page states the flag from the server, not as a claim').toContainText('Flagged as a test record and archived');

      // It really left: the record the flag archived is refused, and it is out of the directory.
      const reread = await page.evaluate(async (id) => (await fetch(`/api/contacts/${id}`)).status, throwaway.id);
      expect(reread, 'an archived contact is refused by its own read').toBe(404);
      const listed = await page.evaluate(async (q) => {
        const r = await fetch(`/api/contacts?search=${encodeURIComponent(q)}`);
        return ((await r.json()) as { contacts: Array<{ last_name: string }> }).contacts.filter((c) => c.last_name === q).length;
      }, lastName);
      expect(listed, 'and it is gone from the client directory').toBe(0);

      /*
       * THE BADGE, on a record that still has one. e2e-boot flags the harness client is_test, so this
       * is the same `c.is_test` the tap above wrote, rendered where an archived record cannot be.
       */
      await page.goto(`/clients/${fixtures.contactId}`);
      await expect(page.locator('.test-client-badge').first(), 'a flagged record wears the TEST badge').toHaveText('TEST');
      await expect(page.getByText('TEST CLIENT — not a real engagement.'), 'and says so before anything else').toBeVisible();
      await expect(
        page.getByRole('button', { name: 'Flag as a test record…' }),
        'and the control is not offered twice on a record already flagged'
      ).toHaveCount(0);

      await page.screenshot({ path: shot, fullPage: true });
      passed = true;
    } finally {
      if (!existsSync(shot)) await page.screenshot({ path: shot, fullPage: true }).catch(() => undefined);
      testInfo.annotations.push({ type: passed ? 'artifact' : 'failure-screenshot', description: keepScreenshot(`test-client-flag-${viewport}`, passed, shot) });
      testInfo.annotations.push({ type: 'walk-step', description: `D2|${FLAG_CONTROL}|${FLAG_ROLES}|tap` });
    }
  });

  test('role proof: the bookkeeper has neither control and both routes refuse her', async ({ page }, testInfo) => {
    const viewport = testInfo.project.name;
    const token = await staffToken();
    // A live (un-archived, un-flagged) contact, so the absence of the flag control is about her role.
    const subject = await asStaff<{ id: string }>(token, '/contacts', {
      method: 'POST', body: JSON.stringify({ firstName: 'Synthetic', lastName: `Rolewall-${viewport}` }),
    });
    const sent = await asStaff<{ id: string; invoiceNumber: string }>(token, '/invoices', {
      method: 'POST',
      body: JSON.stringify({ contactId: fixtures.contactId, lines: [{ code: fixtures.scorp.invoiceItemCode }], send: true }),
    });

    await signIn(page, fixtures.wall.bookkeeper);

    // The money door: the Invoices card cannot even load for her, so there is no Void to tap.
    await page.goto(`/clients/${fixtures.contactId}`);
    await expect(page.getByRole('heading', { name: /Invoices \(/ })).toBeVisible();
    await expect(page.getByText(sent.invoiceNumber), 'the invoice is not on her page').toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Void…' }), 'and no Void control anywhere on it').toHaveCount(0);

    // The identity door.
    await page.goto(`/clients/${subject.id}`);
    await expect(page.getByRole('heading', { name: `Synthetic Rolewall-${viewport}` })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Flag as a test record…' }), 'no test-flag control on her page').toHaveCount(0);

    const refusals = await page.evaluate(async ({ invoiceId, contactId }) => {
      const v = await fetch(`/api/invoices/${invoiceId}/void`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'role proof: this must be refused' }) });
      const f = await fetch(`/api/contacts/${contactId}/archive`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'role proof: this must be refused', isTest: true, testNote: 'role proof: this must be refused' }) });
      return { voidStatus: v.status, flagStatus: f.status };
    }, { invoiceId: sent.id, contactId: subject.id });
    expect(refusals.voidStatus, 'void refuses a role without billing.manage').toBe(403);
    expect(refusals.flagStatus, 'the test flag refuses a role without contacts.write').toBe(403);
    // The invoice this proof issued is retired the way a person would retire it, so the harness
    // client is left with exactly the payable invoices the portal walk expects (a second one, left
    // sent here, made portal-invoices count two Pay buttons on 2026-09-20).
    await asStaff(token, `/invoices/${sent.id}/void`, { method: 'POST', body: JSON.stringify({ reason: 'Issued only to prove the refusal; nothing is owed on it.' }) });

    testInfo.annotations.push({ type: 'walk-step', description: `D1|role proof: bookkeeper sees no invoice and no Void control, POST /invoices/:id/void refused 403|${VOID_ROLES}|tap` });
    testInfo.annotations.push({ type: 'walk-step', description: `D2|role proof: bookkeeper sees no flag control, POST /contacts/:id/archive refused 403|${FLAG_ROLES}|tap` });
  });
});
