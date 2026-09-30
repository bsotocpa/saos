/*
 * THE HANDOVER REHEARSAL (Brian, 2026-09-30, R99) — path O, at 390 × 844 and 1280 × 800.
 *
 * The R74 handover doc (docs/handover/2026-10-19-ana-maria.md) walked as written, by a new tax_preparer,
 * against the harness as production stands today (the four Ops switches as on the box: refund control
 * on, quote builder v2, the stepper on, the business page on). Every label the doc prints in bold that
 * this walk reaches is read from the doc file itself (`says`), so the doc and the screen are held to
 * each other: a doc that loses the words fails here, and a screen that renames them fails here.
 *
 *   O1  first sign-in: Brian's temporary password from Admin → Staff (the notice mailed, never the
 *       password), the QR code and its Secret, the six-digit code, the eight recovery codes and
 *       "I saved these", the own password on Account security; the temporary password no longer signs
 *       in; a recovery code signs in once and Brian is alerted; "Issue new recovery codes" on Account
 *       needs a current code and replaces the set.
 *   O2  My Queue: the landing page, the top bar exactly as the doc lists it.
 *   O3  a return through the five phases: the paper engagement letter, Assign preparer, Lock estimate,
 *       Schedule; Request documents, Start preparation, Internal review; Deliver Return, Record 8879
 *       sent, the signed 8879; Set final fee, Ready to file, Mark filed with federal e-filed and a state
 *       on paper; the ATX report (Hold, Unhold, Release), Record mailing; completed, the final-fee
 *       invoice issued.
 *   O4  a 990: Record extension on Form 8868, the 8879-TE, federal alone, accepted through the report.
 *
 * The new member is deactivated at the end, whatever happens: with two active tax_preparers a new
 * return has no default preparer, and other walks assert the sole-preparer default (walks run one at a
 * time, workers: 1). Synthetic data only; the accounts die with the harness database.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import * as OTPAuth from 'otpauth';
import jsQR from 'jsqr';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { opsSignOut } from './ops-sign-out';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..');
interface Persona { email: string; password: string; totpSecret: string }
const fixtures = JSON.parse(readFileSync(resolve(here, '..', '.artifacts', 'fixtures.json'), 'utf8')) as {
  port: number;
  staff: Persona;
  scorp: { taxYear: number };
};
const API = `http://127.0.0.1:${fixtures.port}`;
const DOC_PATH = resolve(root, 'docs', 'handover', '2026-10-19-ana-maria.md');
const DOC = readFileSync(DOC_PATH, 'utf8');
const ROLES = 'tax_preparer (the new member, as the doc addresses her); ceo for Admin → Staff and the setup she does not hold';
const chicagoToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
const PDF = (name: string, body: string) => ({ name, mimeType: 'application/pdf', buffer: Buffer.from(`%PDF-1.4 ${body}\n%%EOF`) });
const CODE_SHAPE = /^[A-Z2-9]{4}-[A-Z2-9]{4}$/;
const totp = (secret: string) => new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) }).generate();

/** A label the doc prints in bold: asserted to be in the doc, returned for the locator. */
function says(label: string): string {
  expect(DOC.includes(`**${label}**`), `the handover doc prints **${label}**`).toBe(true);
  return label;
}
/** A sentence the doc states, asserted to be in the doc (for the claims the walk checks). */
function states(sentence: string): void {
  expect(DOC.includes(sentence), `the handover doc says "${sentence}"`).toBe(true);
}
async function apiSignIn(page: Page, who: Persona): Promise<void> {
  await page.goto('/login');
  const status = await page.evaluate(async ({ email, password, code }) => {
    const r = await fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password, totp: code }) });
    sessionStorage.setItem('saos_staff_authed', '1');
    return r.status;
  }, { email: who.email, password: who.password, code: totp(who.totpSecret) });
  expect(status, `${who.email} signs in`).toBe(200);
}
/** The sign-in form typed by hand, after React owns it (see ops-mfa-recovery: WebKit hydration). */
async function typeSignIn(page: Page, email: string, password: string, secondFactor?: string): Promise<void> {
  await page.goto('/login');
  await page.waitForLoadState('networkidle');
  await expect(page.locator('form[data-hydrated="true"]')).toHaveCount(1);
  const emailBox = page.getByLabel(says('Email'));
  const passwordBox = page.getByLabel(says('Password'), { exact: true });
  const codeBox = page.getByLabel(says('Authenticator code or recovery code (if enrolled)'));
  await emailBox.fill(email);
  await passwordBox.fill(password);
  if (secondFactor) await codeBox.fill(secondFactor);
  await expect(emailBox).toHaveValue(email);
  await expect(passwordBox).toHaveValue(password);
  if (secondFactor) await expect(codeBox).toHaveValue(secondFactor);
  await page.getByRole('button', { name: says('Sign in') }).click();
}
async function ceoToken(): Promise<string> {
  const { email, password, totpSecret } = fixtures.staff;
  const r = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password, totp: totp(totpSecret) }) });
  expect(r.status, 'the CEO signs in through the API').toBe(200);
  return ((await r.json()) as { token: string }).token;
}
async function asCeo<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch(`${API}${path}`, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(init.headers ?? {}) } });
  const body = (await r.json().catch(() => ({}))) as T;
  expect(r.status, `${init.method ?? 'GET'} ${path}: ${JSON.stringify(body)}`).toBeLessThan(300);
  return body;
}
async function read(page: Page, path: string): Promise<Record<string, unknown>> {
  return page.evaluate(async (p) => (await fetch(`/api${p}`)).json().catch(() => ({})), path);
}
async function mail(): Promise<Array<{ to: string; subject: string; text: string; opsLinks: string[] }>> {
  const r = await fetch(`${API}/harness/mail-links`);
  return ((await r.json()) as { staffMails: Array<{ to: string; subject: string; text: string; opsLinks: string[] }> }).staffMails;
}
function keepScreenshot(name: string, passed: boolean, file: string): string {
  const dir = passed ? resolve(here, '..', '.artifacts', chicagoToday()) : resolve(root, 'tasks', 'walks', chicagoToday());
  mkdirSync(dir, { recursive: true });
  const target = resolve(dir, `${name}.png`);
  if (existsSync(file)) copyFileSync(file, target);
  return target;
}
/** A confirm-modal press: the card's button, then the modal's button of the same name. */
async function confirmed(page: Page, scope: Locator, label: string): Promise<void> {
  const dialog = page.locator('[role=dialog]');
  await scope.getByRole('button', { name: label, exact: true }).first().click();
  await expect(dialog, `"${label}" asks before anything changes`).toBeVisible();
  await dialog.getByRole('button', { name: label, exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.waitForTimeout(300);
}
function atxReport(rows: string[]): string {
  const fixture = readFileSync(resolve(root, 'apps', 'api', 'test', 'fixtures', 'atx', 'ATX_EFiles_synthetic.csv'), 'utf8').replace(/\s+$/, '');
  return [fixture, ...rows].join('\n');
}
const atxDate = (day: string) => `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}/${day.slice(0, 4)}`;

// A control the doc names and the screen lacks fails in 30 s, not at the end of the whole walk's budget.
test.use({ actionTimeout: 30_000 });

test.describe('Ops → the handover doc, walked (R99)', () => {
  test('O1–O4: first sign-in, My Queue, a return through five phases, a 990 on 8868 with its 8879-TE, the ATX report', async ({ page }, testInfo) => {
    test.setTimeout(600_000);
    const viewport = testInfo.project.name;
    const side = viewport === 'desk' ? 'Desk' : 'Phone';
    const shot = testInfo.outputPath(`handover-${viewport}.png`);
    const steps: string[] = [];
    const dialog = page.locator('[role=dialog]');
    const email = `handover-${viewport}@example.test`;
    const displayName = `Handover ${side}`;
    const ownPassword = `handover-${viewport}-own-password-2026`;
    let memberId = '';
    let passed = false;
    const ceo = await ceoToken();
    try {
      // ── O1. FIRST SIGN-IN ─────────────────────────────────────────────────────────────
      states('Brian gives you a temporary password in person. It works for one sign-in and expires after 72 hours.');
      await apiSignIn(page, fixtures.staff);
      await page.goto('/admin/staff');
      const add = page.locator('section.card', { has: page.getByRole('heading', { name: 'Add staff' }) });
      await add.getByLabel(/^Legal name/).fill(`Synthetic Handover ${side}`);
      await add.getByLabel(/^Display name/).fill(displayName);
      await add.getByLabel(/^Email/).fill(email);
      await add.getByLabel(/^Role/).selectOption('tax_preparer');
      await add.getByRole('button', { name: 'Create account' }).click();
      const reveal = page.getByTestId('temp-password-reveal');
      await expect(reveal).toBeVisible();
      const tempPassword = (await reveal.locator('code').textContent())?.trim() ?? '';
      expect(tempPassword.length).toBeGreaterThan(10);
      await reveal.getByRole('button', { name: 'I have handed it over' }).click();
      memberId = await page.evaluate(async (e) => {
        const j = (await (await fetch('/api/staff')).json()) as { staff: Array<{ id: string; email: string }> };
        return j.staff.find((s) => s.email === e)?.id ?? '';
      }, email);
      expect(memberId).not.toBe('');
      await opsSignOut(page);
      states('SAOS also emails you a short notice with the sign-in link when the password is issued; the password itself is never in an email.');
      const notice = (await mail()).find((m) => m.to === email && /temporary password was issued/.test(m.subject));
      expect(notice, 'the notice was mailed to her').toBeTruthy();
      expect(notice!.opsLinks.length, 'with the sign-in link').toBeGreaterThan(0);
      expect(notice!.text, 'never the password').not.toContain(tempPassword);

      states('Go to **https://ops.sotoaccounting.com/login**');
      await typeSignIn(page, email, tempPassword);
      const secretEl = page.getByTestId('totp-secret');
      await expect(secretEl, 'the next screen enrols the authenticator').toBeVisible();
      await expect(page.getByText(new RegExp(`^${says('Secret')}:`)), 'DOC 1.2: the screen names the text beneath the QR code "Secret"').toBeVisible();
      const qr = page.getByTestId('totp-qr');
      await expect(qr).toBeVisible();
      await expect.poll(async () => qr.evaluate((c) => (c as HTMLCanvasElement).width)).toBeGreaterThan(0);
      const pixels = await qr.evaluate((c) => {
        const canvas = c as HTMLCanvasElement;
        const d = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height);
        return { w: canvas.width, h: canvas.height, data: Array.from(d.data) };
      });
      const secret = (await secretEl.textContent())?.trim() ?? '';
      const decoded = jsQR(new Uint8ClampedArray(pixels.data), pixels.w, pixels.h);
      expect(new URL(decoded!.data).searchParams.get('secret'), 'scanning the code gives the same account as typing the Secret').toBe(secret);
      await page.getByLabel(says('Code from your authenticator')).fill(totp(secret));
      await page.getByRole('button', { name: says('Enable MFA + sign in') }).click();
      await expect(page.getByTestId('recovery-codes-panel')).toBeVisible();
      const codes = (await page.getByTestId('recovery-codes').locator('li').allTextContents()).map((c) => c.trim());
      states('You see eight recovery codes, shown only this once.');
      expect(codes.length).toBe(8);
      for (const c of codes) expect(c).toMatch(CODE_SHAPE);
      await page.getByRole('button', { name: says('I saved these') }).click();
      await page.waitForURL(/\/account/);
      await expect(page.getByRole('heading', { name: says('Account security') }), 'DOC 1.5: the page is Account security').toBeVisible();
      await page.getByLabel(says('Current password')).fill(tempPassword);
      await page.getByLabel(says('New password (12+ characters)')).fill(ownPassword);
      await page.getByLabel(says('Confirm new password')).fill(ownPassword);
      await page.getByRole('button', { name: says('Change password') }).click();
      await expect(page.getByText(/^Password changed\./)).toBeVisible();
      await opsSignOut(page);
      states('once the authenticator is set up, the temporary password will not sign you in again');
      await typeSignIn(page, email, tempPassword, totp(secret));
      await expect(page.locator('p.field-error[role=alert]'), 'the temporary password is refused now').toBeVisible();
      steps.push(`O1|/admin/staff "Add staff" (tax_preparer) → temporary password; the notice mailed with the sign-in link, never the password; /login "Email", "Password", "Sign in"; the QR code (decoded) and "Secret"; "Code from your authenticator", "Enable MFA + sign in"; eight codes, "I saved these"; /account "Account security": "Current password", "New password (12+ characters)", "Confirm new password", "Change password"; the temporary password refused after|${ROLES}|tap`);

      // The phone not to hand: a recovery code signs in once, Brian is alerted; a new set needs a current code.
      states('Each code works once, and Brian is alerted when one is used.');
      await typeSignIn(page, email, ownPassword, codes[0]!);
      await page.waitForURL((u) => !u.pathname.startsWith('/login'));
      await expect.poll(async () => (await mail()).some((m) => m.to === fixtures.staff.email && m.subject.includes(`${displayName} signed in with an MFA recovery code`)), { message: 'Brian is alerted by email', timeout: 15_000 }).toBe(true);
      await page.goto('/account');
      await expect(page.getByRole('link', { name: says('Account'), exact: true }), 'DOC 1: Account is in her top bar').toBeVisible();
      const recovery = page.locator('section, form, div', { has: page.getByRole('button', { name: says('Issue new recovery codes') }) }).last();
      await recovery.getByLabel('Code from your authenticator').fill(totp(secret));
      await page.getByRole('button', { name: 'Issue new recovery codes' }).click();
      const fresh = page.getByTestId('new-recovery-codes');
      await expect(fresh).toBeVisible();
      expect((await fresh.locator('li').allTextContents()).length, 'a new set of eight').toBe(8);
      await opsSignOut(page);
      await typeSignIn(page, email, ownPassword, codes[1]!);
      await expect(page.locator('p.field-error[role=alert]'), 'the new set replaced the old: an unused old code is refused').toBeVisible();
      steps.push(`O1b|/login with a recovery code in "Authenticator code or recovery code (if enrolled)": signed in once, the CEO mailed "… signed in with an MFA recovery code"; /account "Issue new recovery codes" with "Code from your authenticator" → eight new codes; an unused old code refused|${ROLES}|tap`);

      // ── O2. MY QUEUE ────────────────────────────────────────────────────────────────────
      await typeSignIn(page, email, ownPassword, totp(secret));
      await page.waitForURL(/\/queue$/);
      // R100: one label, the page heading and the top bar alike.
      states('You land on **My Queue**.');
      await expect(page.getByRole('heading', { name: says('My Queue'), exact: true }), 'DOC 2: the queue page is headed My Queue').toBeVisible();
      await expect(page.getByTestId('top-nav').getByRole('link', { name: 'My Queue', exact: true }), 'DOC 2: as the top bar reads').toBeVisible();
      const barLine = /Your top bar has \*\*([^*]+)\*\*\./.exec(DOC);
      expect(barLine, 'the doc lists the top bar').toBeTruthy();
      const docBar = barLine![1]!.split(',').map((s) => s.trim());
      const nav = page.getByTestId('top-nav');
      await expect(nav).toHaveAttribute('data-ready', 'yes');
      expect(await nav.locator('a').allInnerTexts(), 'DOC 2: the top bar, item by item').toEqual(docBar);
      steps.push(`O2|/ → /queue, heading "My Queue" (R100: as the top bar reads); nav[data-testid=top-nav] equals the doc's list (${docBar.length} items)|${ROLES}|tap`);

      // ── SETUP BY THE CEO: the clients and the returns she does not open herself. With two active
      // tax_preparers the 1120-S has no default preparer: the doc's Engage phase assigns one.
      const year = fixtures.scorp.taxYear;
      const day = chicagoToday();
      const a = await asCeo<{ id: string }>(ceo, '/contacts', { method: 'POST', body: JSON.stringify({ firstName: 'Synthetic', lastName: `Handover${side}`, email: `handover-client-${viewport}@example.test` }) });
      const einA = viewport === 'desk' ? '55-5555592' : '55-5555591';
      const entityA = `Harness Handover ${side} Corp, LLC`;
      const bizA = await asCeo<{ id: string }>(ceo, `/contacts/${a.id}/businesses`, { method: 'POST', body: JSON.stringify({ name: entityA, ein: einA, entityType: 's_corp', state: 'IL' }) });
      const retA = await asCeo<{ id: string }>(ceo, '/tax-engagements', {
        method: 'POST',
        body: JSON.stringify({ contactId: a.id, businessId: bizA.id, taxYear: year, returnType: '1120s', clientType: 'business', reason: 'Harness walk: the handover rehearsal (R99); no quote stands behind it.' }),
      });
      const teA = retA.id;
      expect(((await asCeo<{ taxEngagement: { preparer_id: string | null } }>(ceo, `/tax-engagements/${teA}`)).taxEngagement.preparer_id), 'no default preparer while two are active').toBeNull();
      const o = await asCeo<{ id: string }>(ceo, '/contacts', { method: 'POST', body: JSON.stringify({ firstName: 'Synthetic', lastName: `Handoverexempt${side}`, email: `handover-exempt-${viewport}@example.test` }) });
      const einO = viewport === 'desk' ? '90-0004432' : '90-0004431';
      const orgName = `Synthetic Handover Exempt ${side}`;
      const bizO = await asCeo<{ id: string }>(ceo, `/contacts/${o.id}/businesses`, { method: 'POST', body: JSON.stringify({ name: orgName, ein: einO, entityType: 'nonprofit', state: 'IL', fiscalYearEndMonth: 12 }) });
      const retO = await asCeo<{ id: string }>(ceo, '/tax-engagements', {
        method: 'POST',
        body: JSON.stringify({ contactId: o.id, businessId: bizO.id, taxYear: year, returnType: '990', clientType: 'nonprofit', preparerId: memberId, reason: 'Harness walk: the handover rehearsal (R99), the 990.' }),
      });
      const teO = retO.id;

      // ── O3. A RETURN THROUGH THE FIVE PHASES ─────────────────────────────────────────
      // Engage. The return has no preparer yet, so it is not in her queue: she finds the client under Clients.
      await page.getByTestId('top-nav').getByRole('link', { name: says('Clients'), exact: true }).click();
      await page.getByLabel('Search').fill(`Handover${side}`);
      await page.locator('a:visible', { hasText: new RegExp(`Synthetic Handover${side}(?!\w)`) }).first().click();
      await page.waitForURL(new RegExp(`/clients/${a.id}$`));
      const card = page.locator('section.card', { has: page.getByRole('heading', { name: 'Returns' }) });
      await expect(card).toBeVisible();
      await expect(card.getByTestId('return-stepper').first(), 'DOC 3: the Returns card shows the five phases as a rail (the stepper is on in production)').toBeVisible();
      for (const phase of ['Engage', 'Prepare', 'Sign', 'File', 'Close']) {
        await expect(card.getByText(phase, { exact: true }).first(), `DOC 3: the rail names ${phase}`).toBeVisible();
      }
      await card.getByLabel(says('Signed engagement letter (scan)')).setInputFiles(PDF(`HARNESS-HANDOVER-LETTER-${viewport}.pdf`, 'synthetic signed engagement letter'));
      await card.getByLabel(says('Date signed')).fill(day);
      await card.getByRole('button', { name: says('Upload the signed engagement letter') }).click();
      await expect(dialog, 'DOC 3: an upload acts as soon as it is pressed').toHaveCount(0);
      await expect(card.getByRole('button', { name: 'Upload the signed engagement letter' }), 'the letter is on file').toHaveCount(0);
      await card.getByRole('button', { name: says('Assign preparer') }).first().click();
      await dialog.getByTestId('preparer-select').locator('select').selectOption(memberId);
      await dialog.getByRole('button', { name: 'Assign preparer' }).click();
      await expect(dialog).toHaveCount(0);
      await card.getByRole('button', { name: says('Lock estimate') }).first().click();
      await dialog.getByLabel(says('Low end (dollars)'), { exact: true }).fill('600');
      await dialog.getByLabel(says('High end (dollars)'), { exact: true }).fill('800');
      await dialog.getByRole('button', { name: 'Lock estimate' }).click();
      await expect(dialog).toHaveCount(0);
      await confirmed(page, card, says('Schedule'));
      steps.push(`O3a|Clients → Search → the client → Returns card (the five-phase rail): "Signed engagement letter (scan)", "Date signed", "Upload the signed engagement letter"; "Assign preparer" (herself); "Lock estimate" (low, high); "Schedule"|${ROLES}|tap`);

      // Prepare, from her queue now that the return is hers.
      await page.getByTestId('top-nav').getByRole('link', { name: 'My Queue', exact: true }).click();
      const queueRow = page.locator('section.card', { has: page.getByText(`Synthetic Handover${side}`) });
      await expect(queueRow, 'assigned, the return is in her queue').toBeVisible();
      await queueRow.getByRole('link', { name: says('Client packet') }).click();
      await page.waitForURL(new RegExp(`/clients/${a.id}$`));
      for (const label of ['Request documents', 'Start preparation', 'Internal review']) await confirmed(page, card, says(label));
      expect(((await read(page, `/tax-engagements/${teA}`)).taxEngagement as { stage: string }).stage).toBe('internal_review');
      steps.push(`O3b|My Queue row "Client packet" → Returns card: "Request documents", "Start preparation", "Internal review", each confirmed|${ROLES}|tap`);

      // Sign.
      await page.getByTestId('top-nav').getByRole('link', { name: says('Deliver Return'), exact: true }).click();
      await page.getByLabel('Find the client').fill(`handover-client-${viewport}@example.test`);
      await page.getByLabel('Find the client').press('Enter');
      await page.locator('button.btn.ghost', { hasText: `handover-client-${viewport}@example.test` }).click();
      await expect(page.getByLabel(says('Tax engagement'))).toHaveValue(teA);
      await page.getByLabel(says('Final return PDF (from ATX)')).setInputFiles(PDF(`HARNESS-HANDOVER-1120S-${viewport}.pdf`, 'synthetic 1120S return'));
      await expect(page.getByTestId('delivery-result')).toContainText('The stage moved to Client Review.');
      await page.goto(`/clients/${a.id}`);
      await page.getByTestId('record-8879-sent').first().click();
      const methods = (await dialog.getByTestId('sent-8879-method').locator('option').allInnerTexts()).map((t) => t.trim());
      states('choose the **Method** (Adobe Sign, In office or Mailed) and the **Date sent**');
      expect(methods, 'DOC 3 Sign: the Method choices').toEqual(['Adobe Sign', 'In office', 'Mailed']);
      await dialog.getByTestId('sent-8879-method').locator('select').selectOption('in_office');
      await expect(dialog.getByLabel(says('Date sent'))).toHaveValue(chicagoToday());
      await dialog.getByRole('button', { name: says('Record 8879 sent') }).click();
      await expect(dialog).toHaveCount(0);
      const upload = page.getByTestId('upload-8879-form').first();
      await upload.getByLabel(says('Signed 8879 (scan)')).setInputFiles(PDF(`HARNESS-HANDOVER-8879-${viewport}.pdf`, 'synthetic signed 8879-S'));
      await upload.getByLabel(says('Signed on')).fill(chicagoToday());
      await upload.getByLabel(says('PTIN holder')).selectOption(memberId);
      await expect(upload.getByLabel(says('Form'))).toBeVisible();
      await upload.getByRole('button', { name: says('Upload the signed 8879') }).click();
      await expect(dialog, 'DOC 3: an upload acts as soon as it is pressed').toHaveCount(0);
      await expect(upload).toHaveCount(0);
      steps.push(`O3c|Deliver Return: "Find the client", "Tax engagement", "Final return PDF (from ATX)" → Client Review; "Record 8879 sent" (Method, Date sent); "Signed 8879 (scan)", "Signed on", "PTIN holder", "Form", "Upload the signed 8879"|${ROLES}|tap`);

      // File: the fee, ready, filed with federal e-filed and Illinois on paper.
      await page.getByRole('button', { name: says('Set final fee') }).first().click();
      await dialog.getByLabel(says('Final fee (dollars)')).fill('700.00');
      await dialog.getByRole('button', { name: 'Set final fee' }).click();
      await expect(dialog).toHaveCount(0);
      await confirmed(page, page.locator('main'), says('Ready to file'));
      await page.getByRole('button', { name: says('Mark filed') }).first().click();
      await expect(dialog.getByLabel(says('Filed on'))).toHaveValue(chicagoToday());
      await expect(dialog.getByLabel(says('PTIN holder (the paid preparer of record)'))).toHaveValue(memberId);
      await expect(dialog.getByText(says('Jurisdictions filed'))).toBeVisible();
      await expect(dialog.getByLabel(says('Add a state (two-letter code)'))).toBeVisible();
      await expect(dialog.getByRole('button', { name: says('Add state') })).toBeVisible();
      states('Federal is always listed');
      await expect(dialog.getByTestId('filing-method-federal')).toHaveValue('efile');
      await dialog.getByTestId('filing-method-IL').selectOption('paper');
      const methodNames = (await dialog.getByTestId('filing-method-federal').locator('option').allInnerTexts()).map((t) => t.trim());
      states('mark each jurisdiction E-filed or Paper (mailed)');
      expect(methodNames, 'DOC 3 File: the filing methods').toEqual(['E-filed', 'Paper (mailed)']);
      await dialog.getByRole('button', { name: 'Mark filed' }).click();
      await expect(dialog).toHaveCount(0);
      expect(((await read(page, `/tax-engagements/${teA}`)).taxEngagement as { stage: string }).stage).toBe('filed');
      steps.push(`O3d|"Set final fee" ("Final fee (dollars)"), "Ready to file", "Mark filed" ("Filed on", "PTIN holder (the paid preparer of record)", "Jurisdictions filed": Federal E-filed, IL Paper (mailed); "Add a state (two-letter code)", "Add state")|${ROLES}|tap`);

      // The ATX report: federal accepted; Hold and Unhold; release.
      const exportName = entityA.toUpperCase().replace(/[.,]/g, '');
      const last4A = einA.slice(-4);
      await page.getByTestId('top-nav').getByRole('link', { name: says('E-file acks'), exact: true }).click();
      await expect(page.getByText(says('Upload ATX report'))).toBeVisible();
      await page.locator('input[type=file]').setInputFiles({ name: `E-Files-handover-${viewport}.csv`, mimeType: 'text/csv', buffer: Buffer.from(atxReport([
        `${exportName},,,90000${last4A},hoFed${last4A}${viewport}q7k2,Federal,1120S,Federal,Accepted,${atxDate(chicagoToday())} 6:41:08 PM,TBD,0,Zero Balance,,0,Ogden`,
      ]), 'utf8') });
      states('Nothing is sent at this point.');
      await expect(page.getByRole('status')).toContainText('Nothing has been sent');
      await expect(page.getByRole('button', { name: says('Open') }).first(), 'DOC 4: the report list has Open').toBeVisible();
      states('**Upload ATX report** act as soon as you press them');
      await page.getByRole('button', { name: says('Hold'), exact: true }).first().click();
      await expect(page.getByRole('button', { name: 'Unhold', exact: true }).first()).toBeVisible();
      await page.getByRole('button', { name: 'Unhold', exact: true }).first().click();
      states('Press **Release N to clients**, then **Release N**.');
      await page.getByRole('button', { name: 'Release 1 to clients' }).click();
      await dialog.getByRole('button', { name: 'Release 1', exact: true }).click();
      await expect(page.getByRole('status')).toContainText('Released:');
      steps.push(`O3e|E-file acks "Upload ATX report" → "Nothing has been sent"; "Open"; "Hold", "Unhold"; "Release 1 to clients", "Release 1"|${ROLES}|tap`);

      // The paper state, mailed; Close.
      await page.goto(`/clients/${a.id}`);
      await page.getByRole('button', { name: says('Record mailing — IL'), exact: true }).first().click();
      await dialog.getByLabel(says('Mailed on')).fill(chicagoToday());
      await expect(dialog.getByTestId('mailing-method')).toBeVisible();
      await dialog.getByLabel(says('Tracking number')).fill('9400100000000000000001');
      await dialog.getByRole('button', { name: says('Record mailing') }).click();
      await expect(dialog).toHaveCount(0);
      states('The return completes by itself once every jurisdiction has been accepted or mailed.');
      await expect.poll(async () => ((await read(page, `/tax-engagements/${teA}`)).taxEngagement as { stage: string }).stage, { message: 'accepted and mailed: completed' }).toBe('completed');
      states('Filing issues the final-fee invoice');
      const invoices = await asCeo<{ invoices: Array<{ status: string }> }>(ceo, `/invoices?contactId=${a.id}`);
      expect(invoices.invoices.length, 'the final-fee invoice was issued').toBeGreaterThan(0);
      steps.push(`O3f|"Record mailing" ("Mailed on", "Method", "Tracking number") for IL → the return completed; the final-fee invoice issued|${ROLES}|tap`);

      // ── O4. A 990: RECORD EXTENSION ON 8868, THE 8879-TE, FEDERAL ALONE ────────────────
      await page.goto(`/clients/${o.id}`);
      await expect(card).toBeVisible();
      states('the rail offers **Change preparer** instead');
      await expect(card.getByRole('button', { name: says('Change preparer') }).first(), 'DOC 3: a return already assigned to her offers Change preparer').toBeVisible();
      await expect(card.getByRole('button', { name: 'Assign preparer', exact: true }), 'and no Assign preparer').toHaveCount(0);
      await card.getByLabel('Signed engagement letter (scan)').setInputFiles(PDF(`HARNESS-HANDOVER-990-LETTER-${viewport}.pdf`, 'synthetic signed engagement letter'));
      await card.getByLabel('Date signed').fill(day);
      await card.getByRole('button', { name: 'Upload the signed engagement letter' }).click();
      await expect(card.getByRole('button', { name: 'Upload the signed engagement letter' })).toHaveCount(0);
      await card.getByRole('button', { name: says('Record extension') }).first().click();
      states('(8868 for a 990)');
      await expect(dialog.getByTestId('extension-form').locator('select'), 'DOC 3: a 990 extends on 8868').toHaveValue('8868');
      await expect(dialog.getByText(says('Extension form'))).toBeVisible();
      await dialog.getByLabel(says('Date filed')).fill(chicagoToday());
      await dialog.getByRole('button', { name: 'Record extension' }).click();
      await expect(dialog).toHaveCount(0);
      expect(((await read(page, `/tax-engagements/${teO}`)).taxEngagement as { extension_form: string }).extension_form).toBe('8868');
      await card.getByRole('button', { name: 'Lock estimate' }).first().click();
      await dialog.getByLabel(/^Low end/).fill('400');
      await dialog.getByLabel(/^High end/).fill('600');
      await dialog.getByRole('button', { name: 'Lock estimate' }).click();
      await expect(dialog).toHaveCount(0);
      for (const label of ['Schedule', 'Request documents', 'Start preparation', 'Internal review']) await confirmed(page, card, label);
      await page.goto('/upload-return');
      await page.getByLabel('Find the client').fill(`handover-exempt-${viewport}@example.test`);
      await page.getByLabel('Find the client').press('Enter');
      await page.locator('button.btn.ghost', { hasText: `handover-exempt-${viewport}@example.test` }).click();
      await expect(page.getByLabel('Tax engagement')).toHaveValue(teO);
      await page.getByLabel('Final return PDF (from ATX)').setInputFiles(PDF(`HARNESS-HANDOVER-990-${viewport}.pdf`, 'synthetic 990 return'));
      await expect(page.getByTestId('delivery-result')).toContainText('The stage moved to Client Review.');
      await page.goto(`/clients/${o.id}`);
      await page.getByTestId('record-8879-sent').first().click();
      await dialog.getByTestId('sent-8879-method').locator('select').selectOption('in_office');
      await dialog.getByRole('button', { name: 'Record 8879 sent' }).click();
      await expect(dialog).toHaveCount(0);
      const uploadTE = page.getByTestId('upload-8879-form').first();
      states('(8879-TE for a 990)');
      await expect(uploadTE.getByTestId('f8879-variant').locator('select'), 'DOC 3: the Form opens on 8879-TE for a 990').toHaveValue('8879-TE');
      await uploadTE.getByLabel('Signed 8879 (scan)').setInputFiles(PDF(`HARNESS-HANDOVER-8879TE-${viewport}.pdf`, 'synthetic signed 8879-TE'));
      await uploadTE.getByLabel('Signed on').fill(chicagoToday());
      await expect(uploadTE.getByLabel('PTIN holder')).toHaveValue(memberId);
      await uploadTE.getByRole('button', { name: 'Upload the signed 8879' }).click();
      await expect(uploadTE).toHaveCount(0);
      await page.getByRole('button', { name: 'Set final fee' }).first().click();
      await dialog.getByLabel('Final fee (dollars)').fill('500.00');
      await dialog.getByRole('button', { name: 'Set final fee' }).click();
      await expect(dialog).toHaveCount(0);
      await confirmed(page, page.locator('main'), 'Ready to file');
      await page.getByRole('button', { name: 'Mark filed' }).first().click();
      await dialog.getByRole('button', { name: 'Remove IL' }).click();
      await dialog.getByRole('button', { name: 'Mark filed' }).click();
      await expect(dialog).toHaveCount(0);
      const orgExport = orgName.toUpperCase();
      const einDigitsO = einO.replace(/\D/g, '');
      await page.goto('/efile-acks');
      await page.locator('input[type=file]').setInputFiles({ name: `E-Files-handover-990-${viewport}.csv`, mimeType: 'text/csv', buffer: Buffer.from(atxReport([
        `${orgExport},,,${einDigitsO},ho990${einDigitsO.slice(-4)}${viewport}k7q2,Federal,990,Federal,Accepted,${atxDate(chicagoToday())} 3:12:07 PM,TBD,0,Zero Balance,,0,Ogden`,
      ]), 'utf8') });
      await expect(page.getByRole('status')).toContainText('1 will send');
      await page.getByRole('button', { name: 'Release 1 to clients' }).click();
      await dialog.getByRole('button', { name: 'Release 1', exact: true }).click();
      await expect(page.getByRole('status')).toContainText('Released:');
      expect(((await read(page, `/tax-engagements/${teO}`)).taxEngagement as { stage: string }).stage, 'federal alone, accepted: completed').toBe('completed');
      steps.push(`O4|the 990: "Record extension" ("Extension form" opening on 8868, "Date filed"); the letter; "Lock estimate" and the stages; Deliver Return; "Record 8879 sent"; "Form" opening on 8879-TE, "Upload the signed 8879"; "Set final fee", "Ready to file", "Mark filed" with "Remove IL"; the ATX report, "Release 1 to clients" → completed|${ROLES}|tap`);

      await page.screenshot({ path: shot, fullPage: true });
      passed = true;
    } finally {
      if (memberId) {
        // The sole-preparer default is back for every walk after this one.
        await fetch(`${API}/staff/${memberId}`, { method: 'PATCH', headers: { 'content-type': 'application/json', authorization: `Bearer ${ceo}` }, body: JSON.stringify({ isActive: false }) });
      }
      if (!existsSync(shot)) await page.screenshot({ path: shot, fullPage: true }).catch(() => undefined);
      testInfo.annotations.push({ type: 'screenshot', description: keepScreenshot(`handover-${viewport}`, passed, shot) });
      for (const s of steps) testInfo.annotations.push({ type: 'walk-step', description: s });
    }
  });
});
