/*
 * DELIVER RETURN SAYS WHAT HAPPENED (Brian, 2026-09-26, R48) — walk step P4, at 390 × 844 and 1280 × 800.
 *
 *   "Deliver Return said 'client notified' but no return-delivered notice is armed. The confirmation
 *    must state what actually happened, including 'the client was not emailed because that notice is
 *    switched off'."
 *
 * Two synthetic returns per viewport, opened at internal review through the API doors (the return
 * record, the signed letter, the estimate lock, the stages — none of them the subject here). The CEO
 * switches the `return_delivered` notice OFF through the admin toggle, delivers the first return on
 * /upload-return and reads "The return is on the portal. The client was not emailed because that
 * notice is switched off."; switches it ON, delivers the second and reads "The client was emailed."
 * The switch is left ON, the harness's state, whatever happens.
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
const fixtures = JSON.parse(readFileSync(resolve(here, '..', '.artifacts', 'fixtures.json'), 'utf8')) as {
  port?: number;
  staff: Persona;
  scorp: { taxYear: number };
};
const API = `http://127.0.0.1:${fixtures.port ?? 3101}`;
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
const PDF = { mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 synthetic harness return (R48) — no real client data\n%%EOF') };
const CONTROL = '/upload-return "Find the client" → the client\'s button → input[type=file] "Final return PDF (from ATX)" → the confirmation line (data-testid delivery-result)';
const ROLES = 'ceo, tax_preparer (documents.write); the admin toggle is admin.settings';
const rx = (s: string): RegExp => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

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
async function uploadSigned(token: string, fields: Record<string, string>, filename: string): Promise<void> {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  fd.append('file', new Blob([PDF.buffer], { type: PDF.mimeType }), filename);
  const r = await fetch(`${API}/documents`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: fd });
  const body = await r.json().catch(() => ({}));
  expect(r.status, `upload ${filename}: ${JSON.stringify(body)}`).toBeLessThan(300);
}
/** A synthetic 1040 at internal review, through the doors: contact, return record, signed letter, estimate, stages. */
async function returnAtReview(token: string, viewport: string, tag: string): Promise<{ contactId: string; lastName: string; te: string }> {
  const lastName = `Deliver${tag}${viewport === 'desk' ? 'Desk' : 'Phone'}`;
  const contact = await asStaff<{ id: string }>(token, '/contacts', {
    method: 'POST', body: JSON.stringify({ firstName: 'Synthetic', lastName, email: `deliver-${tag}-${viewport}@example.test` }),
  });
  const ret = await asStaff<{ id: string }>(token, '/tax-engagements', {
    method: 'POST',
    body: JSON.stringify({ contactId: contact.id, taxYear: fixtures.scorp.taxYear, returnType: '1040', reason: 'Harness walk: a return opened by hand so a delivery can be read; no quote stands behind it.' }),
  });
  await uploadSigned(token, { contactId: contact.id, category: 'signed_authorizations', taxEngagementId: ret.id, engagementLetterSignedOn: today }, `HARNESS-DELIVER-LETTER-${tag}-${viewport}.pdf`);
  await asStaff(token, `/tax-engagements/${ret.id}/estimate`, { method: 'POST', body: JSON.stringify({ minCents: 60000, maxCents: 80000 }) });
  for (const toStage of ['scheduled', 'documents_requested', 'in_preparation', 'internal_review']) {
    await asStaff(token, `/tax-engagements/${ret.id}/transition`, { method: 'POST', body: JSON.stringify({ toStage }) });
  }
  return { contactId: contact.id, lastName, te: ret.id };
}
async function armNotice(token: string, enabled: boolean): Promise<void> {
  await asStaff(token, '/admin/automations/return_delivered', { method: 'PATCH', body: JSON.stringify({ enabled }) });
}
/** Deliver on the page, and read the confirmation line back. */
async function deliverOnPage(page: Page, lastName: string, te: string, filename: string): Promise<string> {
  await page.goto('/upload-return');
  await expect(page.getByRole('heading', { name: 'Deliver a return' })).toBeVisible();
  await page.getByLabel('Find the client').fill(lastName);
  await page.getByLabel('Find the client').press('Enter');
  await page.getByRole('button', { name: rx(lastName) }).first().click();
  await expect(page.getByLabel('Tax engagement')).toHaveValue(te);
  await page.locator('input[type=file]').setInputFiles({ name: filename, ...PDF });
  const result = page.getByTestId('delivery-result');
  await expect(result).toBeVisible();
  return (await result.textContent()) ?? '';
}
function keepScreenshot(name: string, passed: boolean, file: string): string {
  const dir = passed ? resolve(here, '..', '.artifacts', today) : resolve(root, 'tasks', 'walks', today);
  mkdirSync(dir, { recursive: true });
  const target = resolve(dir, `${name}.png`);
  if (existsSync(file)) copyFileSync(file, target);
  return target;
}

test('P4: the confirmation says the client was not emailed with the notice off, and emailed with it on', async ({ page }, testInfo) => {
  const viewport = viewportKey(testInfo);
  const shot = testInfo.outputPath(`ops-deliver-return-${viewport}.png`);
  let passed = false;
  const token = await staffToken();
  try {
    const off = await returnAtReview(token, viewport, 'Off');
    const on = await returnAtReview(token, viewport, 'On');
    await signIn(page, fixtures.staff);

    // OFF: the return lands, the stage moves, the client is NOT emailed — and the page says so.
    await armNotice(token, false);
    const offText = await deliverOnPage(page, off.lastName, off.te, `HARNESS-DELIVER-OFF-${viewport}.pdf`);
    expect(offText).toContain('The return is on the portal. The client was not emailed because that notice is switched off.');
    expect(offText).toContain('The stage moved to Client Review.');
    expect(offText, 'no claim of a notification that did not happen').not.toMatch(/notified/);
    await page.screenshot({ path: shot, fullPage: true });
    const offReturn = (await asStaff<{ taxEngagement: { stage: string } }>(token, `/tax-engagements/${off.te}`)).taxEngagement;
    expect(offReturn.stage, 'the delivery itself is never gated').toBe('client_review');

    // ON: the same door, and the client was emailed.
    await armNotice(token, true);
    const onText = await deliverOnPage(page, on.lastName, on.te, `HARNESS-DELIVER-ON-${viewport}.pdf`);
    expect(onText).toContain('The return is on the portal. The client was emailed.');
    expect(onText).toContain('The stage moved to Client Review.');
    passed = true;
  } finally {
    await armNotice(token, true).catch(() => undefined);
    if (!existsSync(shot)) await page.screenshot({ path: shot, fullPage: true }).catch(() => undefined);
    testInfo.annotations.push({ type: 'screenshot', description: keepScreenshot(`ops-deliver-return-${viewport}`, passed, shot) });
    testInfo.annotations.push({ type: 'walk-step', description: `P4|${CONTROL} at ${viewport}: with return_delivered OFF (PATCH /admin/automations/return_delivered) the line reads "not emailed because that notice is switched off" and the stage still moved; with it ON, "The client was emailed."|${ROLES}|tap` });
  }
});
