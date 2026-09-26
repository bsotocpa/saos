/*
 * THE UPLOAD CONTROL (Brian, 2026-09-26, R47) — walk step P3, at 390 × 844 and 1280 × 800.
 *
 *   "'Choose File' opens the camera with no library option. The control must offer Photo Library,
 *    Take Photo and Choose Files. Allow several files at once. The category starts unselected. The
 *    empty card below the upload has text."
 *
 * The cause was `capture="environment"` on the file input: it tells iOS Safari to open the rear
 * camera directly. The harness cannot show the iOS chooser (WebKit here is not iOS Safari, and the
 * sheet is the operating system's); Brian verifies that on his phone. What it proves, on a client of
 * this spec's own with nothing uploaded: the input carries no capture attribute, is `multiple` and
 * accepts images and PDFs; the category starts on its placeholder; the empty card has its sentence; a
 * file chosen before a category is refused inline and nothing is sent; two files chosen at once make
 * two result lines and two rows.
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
};
const API = `http://127.0.0.1:${fixtures.port ?? 3101}`;
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
const PDF = Buffer.from('%PDF-1.4 synthetic harness upload (R47) — no real client data\n%%EOF');
const CONTROL = 'portal /documents select "Category" (placeholder "Choose a category"), input[type=file] multiple accept="image/*,application/pdf" (no capture), the empty card sentence, one result line per file';

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
async function magicTokens(): Promise<string[]> {
  return ((await (await fetch(`${API}/harness/mail-links`)).json()) as { magicTokens: string[] }).magicTokens;
}
/** A fresh client with portal access and nothing uploaded; the sign-in token is the one 'Grant access' emailed. */
async function freshClient(tag: string): Promise<{ contactId: string; token: string }> {
  const token = await staffToken();
  const before = (await magicTokens()).length;
  const contact = await asStaff<{ id: string }>(token, '/contacts', { method: 'POST', body: JSON.stringify({ firstName: 'Synthetic', lastName: `Upload-${tag}`, email: `upload-${tag}@example.test` }) });
  await asStaff(token, '/portal-users', { method: 'POST', body: JSON.stringify({ contactId: contact.id }) });
  await expect.poll(async () => (await magicTokens()).length, { message: 'the invite reached the mailer' }).toBeGreaterThan(before);
  const tokens = await magicTokens();
  return { contactId: contact.id, token: tokens[tokens.length - 1]! };
}
async function signIn(page: Page, token: string): Promise<void> {
  await page.goto('/login');
  const status = await page.evaluate(async (t) => {
    const r = await fetch('/api/portal/auth/magic/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: t }) });
    localStorage.setItem('saos_portal_authed', '1');
    return r.status;
  }, token);
  expect(status, 'redeeming the sign-in link the client was emailed').toBe(200);
}
function keepScreenshot(name: string, passed: boolean, file: string): string {
  const dir = passed ? resolve(here, '..', '.artifacts', today) : resolve(root, 'tasks', 'walks', today);
  mkdirSync(dir, { recursive: true });
  const target = resolve(dir, `${name}.png`);
  if (existsSync(file)) copyFileSync(file, target);
  return target;
}

test('P3: the upload control — no capture, multiple, the category unselected and required, the empty card, two files at once', async ({ page }, testInfo) => {
  const viewport = testInfo.project.name;
  const shot = testInfo.outputPath(`portal-upload-control-${viewport}.png`);
  let passed = false;
  try {
    const client = await freshClient(viewport);
    await signIn(page, client.token);
    await page.goto('/documents');
    await expect(page.getByRole('heading', { name: 'Document Center' })).toBeVisible();

    // THE CONTROL: a plain file input — this is what lets iOS offer Photo Library / Take Photo / Choose Files.
    const input = page.locator('input[type=file]');
    await expect(input).toHaveCount(1);
    await expect(input, 'no capture attribute: the camera is one choice, not the only one').not.toHaveAttribute('capture', /.*/);
    await expect(input, 'several files at once').toHaveAttribute('multiple', /.*/);
    await expect(input).toHaveAttribute('accept', 'image/*,application/pdf');
    await expect(page.getByText('Choose files (photos work great)')).toBeVisible();

    // THE CATEGORY starts unselected, on its placeholder; the empty card has its sentence.
    const category = page.getByTestId('docs-category');
    await expect(category).toHaveValue('');
    await expect(category.locator('option').first()).toHaveText('Choose a category');
    await expect(page.getByTestId('docs-empty')).toHaveText('Nothing uploaded yet. Files you send us appear here.');
    await expect(page.getByTestId('document-row')).toHaveCount(0);
    await page.screenshot({ path: shot, fullPage: true });

    // A FILE BEFORE A CATEGORY is refused inline, and nothing is sent.
    await input.setInputFiles({ name: `HARNESS-UPLOAD-EARLY-${viewport}.pdf`, mimeType: 'application/pdf', buffer: PDF });
    // The field's own refusal, not Next's route announcer (which is also role=alert).
    await expect(page.locator('p.field-error[role=alert]')).toHaveText('Choose a category first, then pick your files.');
    await expect(page.getByTestId('document-row')).toHaveCount(0);
    await expect(page.getByTestId('upload-result')).toHaveCount(0);

    // TWO FILES AT ONCE, with a category: two result lines, two rows, the empty sentence gone.
    await category.selectOption('tax_documents');
    const names = [`HARNESS-UPLOAD-W2-${viewport}.pdf`, `HARNESS-UPLOAD-1099-${viewport}.pdf`];
    await input.setInputFiles(names.map((name) => ({ name, mimeType: 'application/pdf', buffer: PDF })));
    await expect(page.getByText('Uploaded — thank you!')).toBeVisible();
    await expect(page.getByTestId('upload-result')).toHaveCount(2);
    await expect(page.locator('[data-testid=upload-result][data-ok=true]')).toHaveCount(2);
    const text = await page.evaluate(() => document.body.innerText);
    for (const name of names) expect(text, `${name} has its result line and its row`).toContain(name);
    await expect(page.getByTestId('document-row')).toHaveCount(2);
    await expect(page.getByTestId('docs-empty')).toHaveCount(0);
    await expect(page.locator('p.field-error[role=alert]')).toHaveCount(0);
    passed = true;
  } finally {
    if (!existsSync(shot)) await page.screenshot({ path: shot, fullPage: true }).catch(() => undefined);
    testInfo.annotations.push({ type: 'screenshot', description: keepScreenshot(`portal-upload-control-${viewport}`, passed, shot) });
    testInfo.annotations.push({ type: 'walk-step', description: `P3|${CONTROL} at ${viewport}: no capture attribute and multiple on the input, the placeholder category, the empty-card sentence, a file before a category refused inline, two files uploaded with two result lines and two rows (the iOS chooser itself is Brian's phone to verify)|client (portal sign-in link)|tap` });
  }
});
