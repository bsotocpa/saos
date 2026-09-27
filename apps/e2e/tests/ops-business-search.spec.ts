/*
 * PATH H, THE BUSINESS IN THE SEARCH AND THE STAGE ROW THAT OPENS (Brian, 2026-09-26, R51 and R52).
 *
 *   R51  Every Ops client search matches a business legal name and shows "Business — owner":
 *        Deliver Return (H1), New quote (H2), the clients list (H3). The harness types the S corp
 *        fixture's legal name into each and reads the row as the person would.
 *   R52  Each "Open returns by stage" row on the executive view opens the list for that stage —
 *        client, business, form, preparer, days in stage (H4). The spec opens a return by hand
 *        through the API door on a fresh synthetic client with a business, then taps the row.
 *
 * Both viewports (390 WebKit, 1280 Chrome) as the CEO; each viewport uses its own S corp fixture
 * because both projects share one database.
 */
import { expect, test, type Page } from '@playwright/test';
import * as OTPAuth from 'otpauth';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..');
interface Persona { email: string; password: string; totpSecret: string }
interface Scorp { contactId: string; businessId: string; entityName: string; markers: { business: string }; preparer: { id: string; name: string } }
const fixtures = JSON.parse(readFileSync(resolve(here, '..', '.artifacts', 'fixtures.json'), 'utf8')) as {
  staff: Persona; scorp: Scorp; scorpDesk: Scorp;
};
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
const ROLES = 'ceo (contacts.read for the searches; dashboards.executive for the stage list)';

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
/** "Business — owner", composed from the fixture's legal name and the owner the API returns. */
async function expectedLabel(page: Page, s: Scorp): Promise<string> {
  const owner = await page.evaluate(async (id) => {
    const r = (await (await fetch(`/api/contacts/${id}`)).json()) as { contact: { first_name: string; last_name: string } };
    return `${r.contact.first_name} ${r.contact.last_name}`;
  }, s.contactId);
  return `${s.entityName} — ${owner}`;
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

test.describe('Path H: the business in every Ops search, and the stage row that opens', () => {
  test('H1 Deliver Return: the search matches the business legal name and shows "Business — owner"', async ({ page }, testInfo) => {
    const viewport = testInfo.project.name;
    const s = viewport === 'phone' ? fixtures.scorp : fixtures.scorpDesk;
    const shot = testInfo.outputPath(`search-deliver-${viewport}.png`);
    let passed = false;
    try {
      await signIn(page, fixtures.staff);
      const label = await expectedLabel(page, s);
      await page.goto('/upload-return');
      const box = page.getByLabel('Find the client');
      await box.fill(s.markers.business);
      await box.press('Enter');
      const row = page.locator('button.btn.ghost', { hasText: label }).first();
      await expect(row, 'the row reads the business, a dash, the owner').toBeVisible();
      await page.screenshot({ path: shot, fullPage: true });
      passed = true;
    } finally {
      if (!existsSync(shot)) await page.screenshot({ path: shot, fullPage: true }).catch(() => undefined);
      testInfo.annotations.push({ type: 'screenshot', description: keepScreenshot(`search-deliver-${viewport}`, passed, shot) });
      testInfo.annotations.push({ type: 'walk-step', description: `H1|/upload-return "Find the client", the business legal name, Enter; the match reads "Business — owner"|${ROLES}|tap` });
    }
  });

  test('H2 New quote: the client search matches the business legal name and the chip reads "Business — owner"', async ({ page }, testInfo) => {
    const viewport = testInfo.project.name;
    const s = viewport === 'phone' ? fixtures.scorp : fixtures.scorpDesk;
    const shot = testInfo.outputPath(`search-quote-${viewport}.png`);
    let passed = false;
    try {
      await signIn(page, fixtures.staff);
      const label = await expectedLabel(page, s);
      await page.goto('/pipeline');
      await page.getByRole('button', { name: 'New quote' }).click();
      const builder = page.locator('section.card', { has: page.getByRole('heading', { name: 'Build a quote' }) });
      await builder.getByPlaceholder('Search by name, email, or phone').fill(s.markers.business);
      const chip = builder.locator('button.chip', { hasText: label });
      await expect(chip, 'the chip reads the business, a dash, the owner').toBeVisible();
      await chip.click();
      // The picked client is the active chip carrying the person's name; the group chips beside it are active too.
      await expect(builder.locator('.chip.active', { hasText: label.split(' — ')[1]! }), 'picked: the person is the client on the quote').toBeVisible();
      await page.screenshot({ path: shot, fullPage: true });
      passed = true;
    } finally {
      if (!existsSync(shot)) await page.screenshot({ path: shot, fullPage: true }).catch(() => undefined);
      testInfo.annotations.push({ type: 'screenshot', description: keepScreenshot(`search-quote-${viewport}`, passed, shot) });
      testInfo.annotations.push({ type: 'walk-step', description: `H2|/pipeline "New quote", "Client or lead" search, the business legal name; the chip reads "Business — owner"|${ROLES}|tap` });
    }
  });

  test('H3 the clients list: the search matches the business legal name and the row reads "Business — owner"', async ({ page }, testInfo) => {
    const viewport = testInfo.project.name;
    const s = viewport === 'phone' ? fixtures.scorp : fixtures.scorpDesk;
    const shot = testInfo.outputPath(`search-clients-${viewport}.png`);
    let passed = false;
    try {
      await signIn(page, fixtures.staff);
      const label = await expectedLabel(page, s);
      await searchClients(page, s.markers.business);
      const link = page.getByRole('link', { name: label });
      await expect(link.first(), 'the row reads the business, a dash, the owner').toBeVisible();
      // R40 (2026-09-26): with OPS_BUSINESS_PAGE on (the harness boots it on) a business match opens the
      // business page; ops-business-page.spec.ts U4 reads the client href with the switch off.
      await expect(link.first(), 'and opens the business page while the switch is on').toHaveAttribute('href', `/businesses/${s.businessId}`);
      await page.screenshot({ path: shot, fullPage: true });
      passed = true;
    } finally {
      if (!existsSync(shot)) await page.screenshot({ path: shot, fullPage: true }).catch(() => undefined);
      testInfo.annotations.push({ type: 'screenshot', description: keepScreenshot(`search-clients-${viewport}`, passed, shot) });
      testInfo.annotations.push({ type: 'walk-step', description: `H3|/clients "Search", the business legal name; the row reads "Business — owner" and, with OPS_BUSINESS_PAGE on, opens /businesses/:id|${ROLES}|tap` });
    }
  });

  test('H4 the executive view: an "Open returns by stage" row opens the list for that stage', async ({ page }, testInfo) => {
    const viewport = testInfo.project.name;
    const shot = testInfo.outputPath(`stage-list-${viewport}.png`);
    const lastName = `Stagerow-${viewport}`;
    const businessName = `HARNESS STAGE ROW ${viewport.toUpperCase()} LLC`;
    let passed = false;
    try {
      await signIn(page, fixtures.staff);
      // A fresh synthetic client with a business and a return opened by hand, through the API doors.
      const made = await page.evaluate(async ({ lastName, businessName }) => {
        const post = async (url: string, body: unknown) => {
          const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
          if (!r.ok) throw new Error(`${url}: ${r.status} ${await r.text()}`);
          return (await r.json()) as { id: string };
        };
        const contact = await post('/api/contacts', { firstName: 'Synthetic', lastName, email: `${lastName.toLowerCase()}-${Date.now()}@example.test` });
        const business = await post(`/api/contacts/${contact.id}/businesses`, { name: businessName, entityType: 'llc', state: 'IL' });
        const ret = await post('/api/tax-engagements', {
          contactId: contact.id, businessId: business.id, taxYear: 2024, returnType: '1120s',
          reason: 'Return opened by hand for the harness: the stage row on the executive view is being tapped.',
        });
        return { contactId: contact.id, returnId: ret.id };
      }, { lastName, businessName });

      await page.goto('/');
      const row = page.getByTestId('stage-row-intake_started');
      await expect(row, 'the stage row is a link').toBeVisible();
      await row.click();
      await expect(page).toHaveURL(/\/returns\?stage=intake_started$/);
      await expect(page.getByRole('heading', { name: 'Open returns — Intake started' })).toBeVisible();
      // The desk renders a table row, the phone a card; both are in the markup and the stylesheet shows one.
      const line = page.getByTestId(viewport === 'phone' ? `open-return-card-${made.returnId}` : `open-return-row-${made.returnId}`);
      await expect(line, 'the return is in the list').toBeVisible();
      await expect(line, 'the client').toContainText(`Synthetic ${lastName}`);
      await expect(line, 'the business').toContainText(businessName);
      await expect(line, 'the form and year').toContainText('1120S · 2024');
      await expect(line, 'days in stage: it was opened just now').toContainText('today');
      // The harness has one active tax preparer, and a return opened by hand is assigned to the sole one at creation.
      const preparer = fixtures.scorp.preparer.name;
      if (viewport === 'phone') {
        await expect(line, 'the preparer on the card').toContainText(preparer);
      } else {
        await expect(line.locator('td').nth(3), 'the preparer column').toContainText(preparer);
        await expect(line.getByRole('link', { name: `Synthetic ${lastName}` })).toHaveAttribute('href', `/clients/${made.contactId}`);
      }
      await page.screenshot({ path: shot, fullPage: true });
      passed = true;
    } finally {
      if (!existsSync(shot)) await page.screenshot({ path: shot, fullPage: true }).catch(() => undefined);
      testInfo.annotations.push({ type: 'screenshot', description: keepScreenshot(`stage-list-${viewport}`, passed, shot) });
      testInfo.annotations.push({ type: 'walk-step', description: `H4|/ "Open returns by stage" row (link) opens /returns?stage=…: client, business, form, preparer, days in stage|${ROLES}|tap` });
    }
  });
});
