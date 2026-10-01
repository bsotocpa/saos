/*
 * PATH U, THE BUSINESS PAGE (Brian, 2026-09-26, R40), behind OPS_BUSINESS_PAGE — at 390 × 844 (WebKit)
 * and 1280 × 800 (Chrome), each viewport on its own S corp fixture (the two projects share a database).
 *
 *   U1  from the client page's Businesses card: the business name is a link; the page renders the
 *       entity, the owner with a link back, and the seven cards; the CEO's Edit business door is the
 *       same EditBusinessModal the card opens, and a saved industry is read back on the entity card.
 *   U2  from search: the clients list's "Business — owner" row opens the business page.
 *   U3  the role proof: the bookkeeper (contacts.read, documents.read, no engagements.read, no
 *       billing.manage, no pii.read) reads entity, owners, service facts and documents; Engagements,
 *       Returns and Invoices say "Not available to your role" with no count; the EIN is the last four
 *       only; no Edit business control. Decided by the API's per-card checks, read back through her
 *       own session as well as on the screen.
 *   U4  with the switch off (through the harness-only /harness/business-page door): the route prints
 *       "This page is not switched on.", the Businesses card's name is plain text, and the clients-list
 *       row opens the client. The switch is put back to ON whatever happens.
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
interface Scorp { contactId: string; businessId: string; entityName: string; einLast4: string; markers: { business: string } }
const fixtures = JSON.parse(readFileSync(resolve(here, '..', '.artifacts', 'fixtures.json'), 'utf8')) as {
  port: number; staff: Persona; scorp: Scorp; scorpDesk: Scorp; wall: { bookkeeper: Persona };
};
const API = `http://127.0.0.1:${fixtures.port}`;
const ROLES = 'ceo (contacts.read; every card through *); role proof: bookkeeper (contacts.read, documents.read.all; no engagements.read, billing.manage, pii.read, contacts.write)';
const CARDS = ['card-entity', 'card-owners', 'card-engagements', 'card-returns', 'card-service-facts', 'card-invoices', 'card-documents'];
const chicagoToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());

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
/** The harness's own flip: the body is the state, the answer is the state now held. */
async function flip(state: 'on' | 'off'): Promise<string> {
  const r = await fetch(`${API}/harness/business-page`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ state }) });
  const body = (await r.json().catch(() => ({}))) as { businessPage?: string };
  if (r.status !== 200) throw new Error(`the harness flip answered ${r.status}: ${JSON.stringify(body)}`);
  return body.businessPage ?? '';
}
/** A read of the API from the signed-in session, for the state the screen does not print. */
async function read(page: Page, path: string): Promise<Record<string, unknown>> {
  return page.evaluate(async (p) => (await fetch(`/api${p}`)).json().catch(() => ({})), path);
}
function keepScreenshot(name: string, passed: boolean, file: string): string {
  const today = chicagoToday();
  const dir = passed ? resolve(here, '..', '.artifacts', today) : resolve(root, 'tasks', 'walks', today);
  mkdirSync(dir, { recursive: true });
  const target = resolve(dir, `${name}.png`);
  if (existsSync(file)) copyFileSync(file, target);
  return target;
}
/** "Business — owner", composed from the fixture's legal name and the owner the API returns. */
async function expectedLabel(page: Page, s: Scorp): Promise<string> {
  const r = (await read(page, `/contacts/${s.contactId}`)) as { contact: { first_name: string; last_name: string } };
  return `${s.entityName} — ${r.contact.first_name} ${r.contact.last_name}`;
}
/*
 * THE SEARCH IS TYPED AFTER THE PAGE HAS HYDRATED (2026-09-27, the U4 phone red in the restored run of
 * sabotage 2026-09-27-c). A fill 157 ms after the load event landed on the server-rendered input before
 * React attached its handlers; hydration reset the controlled input to '' and the only contacts request
 * that ever left the page was the unfiltered first load (the trace: no `search=` request, "11 records
 * match", the owner's plain name). The first list request fires from useEffect, so its response is the
 * proof of hydration; the search request is then awaited so the assertion reads the filtered list.
 */
async function searchClients(page: Page, text: string): Promise<void> {
  const firstLoad = page.waitForResponse((r) => r.url().includes('/api/contacts?') && !r.url().includes('search='));
  await page.goto('/clients');
  await firstLoad;
  const searched = page.waitForResponse((r) => r.url().includes('/api/contacts?') && r.url().includes('search='));
  await page.getByLabel('Search').fill(text);
  await searched;
}
async function noHorizontalScroll(page: Page, viewport: string): Promise<void> {
  if (viewport !== 'phone') return;
  const width = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(width.scroll, 'no page-level horizontal scroll at 390').toBeLessThanOrEqual(width.client);
}

test.describe('Path U: the business page', () => {
  test('U1 from the Businesses card: the name opens the business page; the cards render; Edit business saves and reads back', async ({ page }, testInfo) => {
    const viewport = viewportKey(testInfo);
    const s = viewport === 'phone' ? fixtures.scorp : fixtures.scorpDesk;
    const shot = testInfo.outputPath(`business-page-${viewport}.png`);
    let passed = false;
    try {
      await signIn(page, fixtures.staff);
      await page.goto(`/clients/${s.contactId}`);
      const card = page.locator('section.card', { has: page.getByRole('heading', { name: 'Businesses' }) });
      const link = card.getByTestId(`business-link-${s.businessId}`);
      await expect(link, 'the business name is a link when the switch is on').toHaveText(s.entityName);
      await expect(link).toHaveAttribute('href', `/businesses/${s.businessId}`);
      await link.click();
      await expect(page).toHaveURL(new RegExp(`/businesses/${s.businessId}$`));
      await expect(page.getByRole('heading', { level: 1, name: s.entityName })).toBeVisible();
      for (const id of CARDS) await expect(page.getByTestId(id), `${id} renders`).toBeVisible();
      await expect(page.getByTestId('role-unavailable'), 'the CEO is refused nothing').toHaveCount(0);
      // The owner, linked back to the client page, in the header line and in the Owners card.
      await expect(page.getByTestId('business-owner-line').getByRole('link')).toHaveAttribute('href', `/clients/${s.contactId}`);
      await expect(page.getByTestId(`owner-link-${s.contactId}`)).toHaveAttribute('href', `/clients/${s.contactId}`);
      await expect(page.getByTestId('card-owners').getByText('primary for this person'), 'the fixture business is the owner’s primary').toBeVisible();
      // The EIN: the CEO holds pii.read through the wildcard, so the whole number prints, ending in the fixture's last four.
      const ein = page.getByTestId('entity-ein');
      await expect(ein).toHaveText(/^EIN \d\d-\d{7}$/);
      await expect(ein).toContainText(s.einLast4);
      await noHorizontalScroll(page, viewport);
      await page.screenshot({ path: shot, fullPage: true });

      // The Edit door: the same modal the Businesses card opens (R38/R54), saved and read back on the entity card.
      const industry = `harness_business_page_${viewport}`;
      await page.getByTestId(`edit-business-${s.businessId}`).click();
      const dialog = page.locator('[role=dialog]');
      await expect(dialog.getByRole('heading', { name: `Edit ${s.entityName}` })).toBeVisible();
      await expect(dialog.getByLabel(/Legal name/)).toHaveValue(s.entityName);
      await dialog.getByLabel('Industry').fill(industry);
      await dialog.getByRole('button', { name: 'Save business' }).click();
      await expect(dialog).toHaveCount(0);
      await expect(page.getByRole('status')).toHaveText('Business saved.');
      await expect(page.getByTestId('card-entity')).toContainText(industry.replaceAll('_', ' '));
      testInfo.annotations.push({ type: 'edit-door', description: `business|Edit business on /businesses/:id (EditBusinessModal, the Industry field saved and read back)|ceo|tap` });
      passed = true;
    } finally {
      if (!existsSync(shot)) await page.screenshot({ path: shot, fullPage: true }).catch(() => undefined);
      testInfo.annotations.push({ type: 'screenshot', description: keepScreenshot(`business-page-${viewport}`, passed, shot) });
      testInfo.annotations.push({ type: 'walk-step', description: `U1|/clients/:id Businesses card, the business name (a link) → /businesses/:id: h1, the owner link, the seven cards (entity, owners, engagements, returns, service facts, invoices, documents), the full EIN for the CEO; "Edit business" saves the industry and the entity card reads it back|${ROLES}|tap` });
    }
  });

  test('U2 from search: the clients-list "Business — owner" row opens the business page', async ({ page }, testInfo) => {
    const viewport = viewportKey(testInfo);
    const s = viewport === 'phone' ? fixtures.scorp : fixtures.scorpDesk;
    const shot = testInfo.outputPath(`business-page-from-search-${viewport}.png`);
    let passed = false;
    try {
      await signIn(page, fixtures.staff);
      const label = await expectedLabel(page, s);
      await searchClients(page, s.markers.business);
      const row = page.getByRole('link', { name: label }).first();
      await expect(row, 'the row reads the business, a dash, the owner').toBeVisible();
      await expect(row, 'and opens the business page while the switch is on').toHaveAttribute('href', `/businesses/${s.businessId}`);
      await row.click();
      await expect(page).toHaveURL(new RegExp(`/businesses/${s.businessId}$`));
      await expect(page.getByRole('heading', { level: 1, name: s.entityName })).toBeVisible();
      await expect(page.getByTestId('card-service-facts')).toBeVisible();
      await page.screenshot({ path: shot, fullPage: true });
      passed = true;
    } finally {
      if (!existsSync(shot)) await page.screenshot({ path: shot, fullPage: true }).catch(() => undefined);
      testInfo.annotations.push({ type: 'screenshot', description: keepScreenshot(`business-page-from-search-${viewport}`, passed, shot) });
      testInfo.annotations.push({ type: 'walk-step', description: `U2|/clients "Search", the business legal name; the "Business — owner" row's href is /businesses/:id and opens the page|${ROLES}|tap` });
    }
  });

  test('U3 role proof: the bookkeeper reads entity, owners, service facts and documents; Engagements, Returns and Invoices say "Not available to your role"; EIN last four only; no Edit', async ({ page }, testInfo) => {
    const viewport = viewportKey(testInfo);
    const s = viewport === 'phone' ? fixtures.scorp : fixtures.scorpDesk;
    const shot = testInfo.outputPath(`business-page-bookkeeper-${viewport}.png`);
    let passed = false;
    try {
      await signIn(page, fixtures.wall.bookkeeper);
      await page.goto(`/businesses/${s.businessId}`);
      await expect(page.getByRole('heading', { level: 1, name: s.entityName })).toBeVisible();
      for (const id of CARDS) await expect(page.getByTestId(id), `${id} renders for her`).toBeVisible();
      for (const card of ['engagements', 'returns', 'invoices']) {
        const sec = page.getByTestId(`card-${card}`);
        await expect(sec.locator(`[data-testid=role-unavailable][data-card=${card}]`), `${card}: the sentence`).toHaveText('Not available to your role');
        await expect(sec.getByRole('heading', { level: 2 }), `${card}: no count beside a refused card`).not.toHaveText(/\(\d+\)/);
      }
      for (const card of ['entity', 'owners', 'service-facts', 'documents']) {
        await expect(page.getByTestId(`card-${card}`).getByTestId('role-unavailable'), `${card} is hers to read`).toHaveCount(0);
      }
      await expect(page.getByTestId('role-unavailable'), 'exactly three refused cards').toHaveCount(3);
      const ein = page.getByTestId('entity-ein');
      await expect(ein, 'the last four only').toHaveText(`EIN ending ${s.einLast4}`);
      await expect(ein).not.toHaveText(/\d\d-\d{7}/);
      await expect(page.getByTestId(`edit-business-${s.businessId}`), 'no Edit business for a role without contacts.write or businesses.write').toHaveCount(0);
      // The decision is the server's, read back through her own session.
      const agg = (await read(page, `/businesses/${s.businessId}`)) as { business: { ein?: string }; engagements: { refused?: boolean }; returns: { refused?: boolean }; invoices: { refused?: boolean; permission?: string }; documents: { rows?: unknown[] } };
      expect(agg.engagements.refused, 'engagements refused in the aggregate').toBe(true);
      expect(agg.returns.refused, 'returns refused in the aggregate').toBe(true);
      expect(agg.invoices.refused, 'invoices refused in the aggregate').toBe(true);
      expect(agg.invoices.permission).toBe('billing.manage');
      expect(Array.isArray(agg.documents.rows), 'documents are rows for documents.read.all').toBe(true);
      expect('ein' in agg.business, 'the whole EIN never reached her session').toBe(false);
      await noHorizontalScroll(page, viewport);
      await page.screenshot({ path: shot, fullPage: true });
      passed = true;
    } finally {
      if (!existsSync(shot)) await page.screenshot({ path: shot, fullPage: true }).catch(() => undefined);
      testInfo.annotations.push({ type: 'screenshot', description: keepScreenshot(`business-page-bookkeeper-${viewport}`, passed, shot) });
      testInfo.annotations.push({ type: 'walk-step', description: `U3|/businesses/:id as the bookkeeper: Engagements, Returns and Invoices read "Not available to your role" with no count (the aggregate says refused with the permission); entity, owners, service facts and documents render; "EIN ending ${s.einLast4}", never the whole number; no Edit business|${ROLES}|tap` });
    }
  });

  test('U4 switch off: the route prints "This page is not switched on."; the Businesses card name is plain text; the clients-list row opens the client', async ({ page }, testInfo) => {
    const viewport = viewportKey(testInfo);
    const s = viewport === 'phone' ? fixtures.scorp : fixtures.scorpDesk;
    const shot = testInfo.outputPath(`business-page-off-${viewport}.png`);
    let passed = false;
    try {
      await signIn(page, fixtures.staff);
      expect(await flip('off'), 'the switch is off for this test').toBe('off');
      const me = (await read(page, '/auth/me')) as { switches?: { businessPage?: string } };
      expect(me.switches?.businessPage, 'the session reports the state the pages decide from').toBe('off');

      await page.goto(`/businesses/${s.businessId}`);
      await expect(page.getByTestId('business-page-off')).toHaveText('This page is not switched on.');
      for (const id of CARDS) await expect(page.getByTestId(id), `${id} is not rendered`).toHaveCount(0);
      const refused = (await read(page, `/businesses/${s.businessId}`)) as { error?: string; message?: string };
      expect(refused.error, 'the route refuses too').toBe('business_page_off');
      expect(refused.message).toBe('This page is not switched on.');
      await page.screenshot({ path: shot, fullPage: true });

      await page.goto(`/clients/${s.contactId}`);
      const card = page.locator('section.card', { has: page.getByRole('heading', { name: 'Businesses' }) });
      await expect(card.getByText(s.entityName, { exact: true }), 'the name is still printed').toBeVisible();
      await expect(card.getByTestId(`business-link-${s.businessId}`), 'and is not a link').toHaveCount(0);
      await expect(card.locator(`a[href="/businesses/${s.businessId}"]`)).toHaveCount(0);

      const label = await expectedLabel(page, s);
      await searchClients(page, s.markers.business);
      const row = page.getByRole('link', { name: label }).first();
      await expect(row).toBeVisible();
      await expect(row, 'the row opens the client while the page is off').toHaveAttribute('href', `/clients/${s.contactId}`);
      passed = true;
    } finally {
      // Whatever happened above, the specs after this one tap the business page.
      expect(await flip('on'), 'the switch is back to on').toBe('on');
      if (!existsSync(shot)) await page.screenshot({ path: shot, fullPage: true }).catch(() => undefined);
      testInfo.annotations.push({ type: 'screenshot', description: keepScreenshot(`business-page-off-${viewport}`, passed, shot) });
      testInfo.annotations.push({ type: 'walk-step', description: `U4|OPS_BUSINESS_PAGE=off (through /harness/business-page): /businesses/:id prints "This page is not switched on." and the route answers 409 business_page_off; the Businesses card name is plain text with no link; the clients-list "Business — owner" row's href is /clients/:id; GET /auth/me switches.businessPage reads off|${ROLES}|tap` });
    }
  });
});
