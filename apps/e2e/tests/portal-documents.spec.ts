/*
 * WALK PATH G (R49, Brian, 2026-09-26): the portal Documents page.
 *
 * Brian's own account crashed this page: its two rows were a signed engagement letter
 * (signed_authorizations) and a delivered return (return_deliverable), two categories the portal
 * dictionary never carried, and translate() threw on the first one. G1 reads the page on a fixture
 * client with exactly those two rows plus a client upload made here, through the page's own file
 * control, and asserts three rows and not one console error. G2 forces a render failure through the
 * harness-only switch, reads the sentence and the Reload control, reads the task and the Ops alert
 * the failure raised through the CEO's API, turns the switch off and presses Reload.
 *
 * Both projects: each viewport has its own client, its own two sign-in links, its own rows.
 */
import { expect, test, type Page } from '@playwright/test';
import { redeemPortalToken } from './portal-sign-in';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as OTPAuth from 'otpauth';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..');
interface Person { contactId: string; taxYear: number; portalMagicTokens: string[]; markers: { signedLetter: string; returnFile: string; clientUpload: string } }
const fixtures = JSON.parse(readFileSync(resolve(here, '..', '.artifacts', 'fixtures.json'), 'utf8')) as {
  port: number; portalPort?: number;
  staff: { email: string; password: string; totpSecret: string };
  documents: { phone: Person; desk: Person };
};
const personFor = (project: string): Person => (project === 'desk' ? fixtures.documents.desk : fixtures.documents.phone);
const API = `http://localhost:${fixtures.port}`;
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
const PDF = Buffer.from('%PDF-1.4 synthetic harness upload (R49) — no real client data\n%%EOF');

test.use({ baseURL: `http://localhost:${fixtures.portalPort ?? 3106}` });

async function signIn(page: Page, token: string): Promise<void> {
  await redeemPortalToken(page, '', token);
}
function keepScreenshot(name: string, passed: boolean, file: string): string {
  const dir = passed ? resolve(here, '..', '.artifacts', today) : resolve(root, 'tasks', 'walks', today);
  mkdirSync(dir, { recursive: true });
  const target = resolve(dir, `${name}.png`);
  if (existsSync(file)) copyFileSync(file, target);
  return target;
}
/** Every console error and every uncaught page error, from before the first navigation. */
/*
 * THE ERRORS THIS PAGE CAUSED, BY THE REQUEST THAT FAILED (receipt run 53, 2026-09-30). A failed load
 * is counted from its response, for a request made after the watch began; WebKit's own console line
 * for it ("Failed to load resource") is left to that count, because WebKit delivered Home's 404 on
 * /portal/packet (by design: no packet yet) 55 ms after the walk had moved to this page and begun
 * watching. Every other console error and every uncaught exception still counts.
 */
function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('request', (req) => {
    void req.response().then((res) => {
      if (res && res.status() >= 400) errors.push(`response: ${res.status()} ${req.method()} ${new URL(req.url()).pathname}`);
    }).catch(() => undefined);
  });
  page.on('console', (m) => {
    if (m.type() === 'error' && !/^Failed to load resource: the server responded with a status of \d+/.test(m.text())) errors.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}
async function crashSwitch(on: boolean): Promise<void> {
  const r = await fetch(`${API}/harness/documents-crash`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ on }) });
  expect(r.status, 'the harness switch answers').toBe(200);
}
/** The CEO's own API session, the way the Ops app gets one: password and the code. */
async function ceoToken(): Promise<string> {
  const { email, password, totpSecret } = fixtures.staff;
  const totp = new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(totpSecret) }).generate();
  const r = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password, totp }) });
  expect(r.status, 'the CEO signs in').toBe(200);
  return ((await r.json()) as { token: string }).token;
}

test('the Documents page lists three kinds of row: the signed agreement copy, the delivered return and the client upload', async ({ page }, testInfo) => {
  const viewport = testInfo.project.name;
  const person = personFor(viewport);
  const shot = testInfo.outputPath(`portal-documents-${viewport}.png`);
  let passed = false;
  try {
    await signIn(page, person.portalMagicTokens[0]!);
    // The claim is the Documents page's: errors are watched from here. Signing in lands on Home, whose
    // "no packet yet" read is a 404 by design and is not this page's.
    const errors = watchErrors(page);
    await page.goto('/documents');
    await expect(page.getByRole('heading', { name: 'Document Center' })).toBeVisible();
    // The two staff-filed rows are there before the client does anything: the shapes that crashed.
    await expect(page.getByTestId('document-row')).toHaveCount(2);

    // The client upload, through the page's own control (a tap, not a fixture). The category starts
    // unselected (R47), so it is chosen first, the way a client would.
    await page.getByTestId('docs-category').selectOption('tax_documents');
    await page.locator('input[type=file]').setInputFiles({ name: person.markers.clientUpload, mimeType: 'application/pdf', buffer: PDF });
    await expect(page.getByText('Uploaded — thank you!')).toBeVisible();
    await expect(page.getByTestId('document-row')).toHaveCount(3);

    const text = await page.evaluate(() => document.body.innerText);
    expect(text, 'the signed agreement copy is listed').toContain(person.markers.signedLetter);
    expect(text, 'the delivered return is listed').toContain(person.markers.returnFile);
    expect(text, 'the client upload is listed').toContain(person.markers.clientUpload);
    expect(text, 'the delivered return carries its year').toContain(String(person.taxYear));
    expect(text, 'the staff-filed categories read as words').toContain('Signed authorizations');
    expect(text).toContain('Completed return');
    expect(text, 'the client category reads as words').toContain('Tax documents');
    expect(text, 'no raw enum value reaches the screen').not.toMatch(/\b(signed_authorizations|return_deliverable|tax_documents)\b/);
    expect(text, 'nothing on the page is a raw ISO timestamp').not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    await expect(page.locator('[data-testid=document-row][data-category=signed_authorizations]')).toHaveCount(1);
    await expect(page.locator('[data-testid=document-row][data-category=return_deliverable]')).toHaveCount(1);
    await expect(page.locator('[data-testid=document-row][data-category=tax_documents]')).toHaveCount(1);
    await expect(page.getByTestId('page-error')).toHaveCount(0);
    expect(errors, 'not one console error or uncaught exception').toEqual([]);
    await page.screenshot({ path: shot, fullPage: true });
    passed = true;
  } finally {
    if (!existsSync(shot)) await page.screenshot({ path: shot, fullPage: true }).catch(() => undefined);
    testInfo.annotations.push({ type: 'screenshot', description: keepScreenshot(`portal-documents-${viewport}`, passed, shot) });
    testInfo.annotations.push({ type: 'walk-step', description: `G1|portal /documents at ${viewport}: a signed agreement copy (signed_authorizations), a delivered return (return_deliverable) and a client upload made through the page's file control, three rows, no console error|client (portal sign-in link)|tap` });
  }
});

test('a page that fails to render shows one plain sentence and a Reload control, and the firm is alerted', async ({ page }, testInfo) => {
  const viewport = testInfo.project.name;
  const person = personFor(viewport);
  const shot = testInfo.outputPath(`portal-documents-error-${viewport}.png`);
  let passed = false;
  try {
    await crashSwitch(true);
    await signIn(page, person.portalMagicTokens[1]!);
    await page.goto('/documents');

    const boundary = page.getByTestId('page-error');
    await expect(boundary).toBeVisible();
    await expect(boundary.getByRole('alert')).toHaveText('This page could not be shown. Reloading usually fixes it, and we have been told.');
    const reload = boundary.getByRole('button', { name: 'Reload' });
    await expect(reload).toBeVisible();
    const text = await page.evaluate(() => document.body.innerText);
    expect(text, 'no error text reaches the client').not.toMatch(/TypeError|Cannot read|null|undefined|Application error/);
    await page.screenshot({ path: shot, fullPage: true });

    // The firm was told: one task on the route and one Ops alert pointing at it, read as the CEO.
    const token = await ceoToken();
    const headers = { authorization: `Bearer ${token}` };
    let task: { id: string; title: string; contact_id: string | null } | undefined;
    await expect.poll(async () => {
      const r = await fetch(`${API}/tasks/search?sourceType=portal_page_error`, { headers });
      const { tasks } = (await r.json()) as { tasks: Array<{ id: string; title: string; contact_id: string | null; source_id?: string }> };
      task = tasks.find((x) => x.title.includes('/documents'));
      return task ? 1 : 0;
    }, { message: 'the portal_page_error task for /documents exists', timeout: 15_000 }).toBe(1);
    expect(task!.title, 'the task names the route and nothing about the client').toBe("The portal page /documents failed in a client's browser");
    const alerts = await fetch(`${API}/notifications`, { headers });
    const { notifications } = (await alerts.json()) as { notifications: Array<{ type: string; related_object_id: string | null; title: string }> };
    const alert = notifications.find((n) => n.type === 'portal_page_error' && n.related_object_id === task!.id);
    expect(alert, 'the Ops alert points at the task').toBeTruthy();
    expect(alert!.title).toContain('/documents');

    // Off again, and the control does what it says: the page is back with its rows.
    await crashSwitch(false);
    await reload.click();
    await expect(page.getByRole('heading', { name: 'Document Center' })).toBeVisible();
    // The two staff-filed rows by category, not a count: G1 ran before this on the same client and
    // left its upload behind (three rows in a full run, two when this test runs alone).
    await expect(page.locator('[data-testid=document-row][data-category=signed_authorizations]')).toHaveCount(1);
    await expect(page.locator('[data-testid=document-row][data-category=return_deliverable]')).toHaveCount(1);
    await expect(page.getByTestId('page-error')).toHaveCount(0);
    passed = true;
  } finally {
    await crashSwitch(false).catch(() => undefined);
    if (!existsSync(shot)) await page.screenshot({ path: shot, fullPage: true }).catch(() => undefined);
    testInfo.annotations.push({ type: 'screenshot', description: keepScreenshot(`portal-documents-error-${viewport}`, passed, shot) });
    testInfo.annotations.push({ type: 'walk-step', description: `G2|portal /documents at ${viewport} made to fail through the harness switch: the sentence, the Reload control, the portal_page_error task and the Ops alert read through the CEO API, then Reload shows the rows|client (portal sign-in link); ceo (API)|tap` });
  }
});
