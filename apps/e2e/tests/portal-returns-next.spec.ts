/*
 * MY RETURNS: "WHAT HAPPENS NEXT" (Brian, 2026-09-26, R48) — walk step P5, at 390 × 844 and 1280 × 800.
 *
 * On a client of this spec's own, a synthetic 1040 is walked through the API doors (the return
 * record, the signed letter, the estimate, the stages, the delivery — the taps for those are other
 * steps) and the client reads My Returns after each change of state:
 *
 *   delivered, 8879 not yet sent   "Your return is ready to review. We will send Form 8879 for your signature next."
 *   8879 sent by Adobe Sign (R53)  "Look for an email from Adobe Sign with your Form 8879. Your return is filed once you sign."
 *   the signed 8879 on file        "We have your signed Form 8879 and are filing your return."
 *   filed                          "Filed. We will let you know when it is accepted."
 *   completed                      one line per declared jurisdiction (R48, Brian's words):
 *                                  "Accepted by the IRS on <date>. Mailed to Illinois on <date>."
 *
 * The in-office and mailed sentences share the same block and key shape; the states this spec can
 * reach through the doors are the five above. The return declares federal (e-file) and Illinois (paper)
 * at filing; the IRS acceptance (POST /efile-result) leaves it filed, the Illinois mailing (POST
 * /jurisdictions/IL/mailing) completes it, and the completed line names both with their calendar days.
 */
import { expect, test, type Page } from '@playwright/test';
import { redeemPortalToken } from './portal-sign-in';
import * as OTPAuth from 'otpauth';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { viewportKey } from './viewport';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..');
interface Persona { email: string; password: string; totpSecret: string }
const fixtures = JSON.parse(readFileSync(resolve(here, '..', '.artifacts', 'fixtures.json'), 'utf8')) as {
  port?: number; portalPort?: number;
  staff: Persona;
  scorp: { taxYear: number; preparer: { id: string; name: string } };
};
const API = `http://127.0.0.1:${fixtures.port ?? 3101}`;
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
const PDF = { mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 synthetic harness return (R48) — no real client data\n%%EOF') };
const CONTROL = 'portal /returns row, the "What happens next" block (data-testid returns-next)';

test.use({ baseURL: `http://localhost:${fixtures.portalPort ?? 3106}` });

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
async function upload(token: string, fields: Record<string, string>, filename: string): Promise<void> {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  fd.append('file', new Blob([PDF.buffer], { type: PDF.mimeType }), filename);
  const r = await fetch(`${API}/documents`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: fd });
  const body = await r.json().catch(() => ({}));
  expect(r.status, `upload ${filename}: ${JSON.stringify(body)}`).toBeLessThan(300);
}
async function magicTokens(): Promise<string[]> {
  return ((await (await fetch(`${API}/harness/mail-links`)).json()) as { magicTokens: string[] }).magicTokens;
}
async function signIn(page: Page, token: string): Promise<void> {
  await redeemPortalToken(page, '', token);
}
/** The block, read fresh: the page is reloaded and the one row's next-step key and sentence returned. */
async function readNext(page: Page): Promise<{ step: string | null; text: string }> {
  await page.goto('/returns');
  await expect(page.getByRole('heading', { name: 'My Returns' })).toBeVisible();
  const next = page.getByTestId('returns-next');
  await expect(next).toHaveCount(1);
  return { step: await next.getAttribute('data-step'), text: (await next.textContent()) ?? '' };
}
function keepScreenshot(name: string, passed: boolean, file: string): string {
  const dir = passed ? resolve(here, '..', '.artifacts', today) : resolve(root, 'tasks', 'walks', today);
  mkdirSync(dir, { recursive: true });
  const target = resolve(dir, `${name}.png`);
  if (existsSync(file)) copyFileSync(file, target);
  return target;
}

test('P5: the block reads the return\'s state — 8879 pending, sent by Adobe Sign, on file, filed', async ({ page }, testInfo) => {
  const viewport = viewportKey(testInfo);
  const shot = testInfo.outputPath(`portal-returns-next-${viewport}.png`);
  let passed = false;
  try {
    const token = await staffToken();
    const preparer = fixtures.scorp.preparer.id;
    const before = (await magicTokens()).length;
    const contact = await asStaff<{ id: string }>(token, '/contacts', { method: 'POST', body: JSON.stringify({ firstName: 'Synthetic', lastName: `Returnsnext-${viewport}`, email: `returnsnext-${viewport}@example.test` }) });
    await asStaff(token, '/portal-users', { method: 'POST', body: JSON.stringify({ contactId: contact.id }) });
    await expect.poll(async () => (await magicTokens()).length, { message: 'the invite reached the mailer' }).toBeGreaterThan(before);
    const tokens = await magicTokens();

    const ret = await asStaff<{ id: string }>(token, '/tax-engagements', {
      method: 'POST',
      body: JSON.stringify({ contactId: contact.id, taxYear: fixtures.scorp.taxYear, returnType: '1040', preparerId: preparer, reason: 'Harness walk: a return opened by hand so My Returns can be read at each state; no quote stands behind it.' }),
    });
    await upload(token, { contactId: contact.id, category: 'signed_authorizations', taxEngagementId: ret.id, engagementLetterSignedOn: today }, `HARNESS-NEXT-LETTER-${viewport}.pdf`);
    await asStaff(token, `/tax-engagements/${ret.id}/estimate`, { method: 'POST', body: JSON.stringify({ minCents: 60000, maxCents: 80000 }) });
    for (const toStage of ['scheduled', 'documents_requested', 'in_preparation', 'internal_review']) {
      await asStaff(token, `/tax-engagements/${ret.id}/transition`, { method: 'POST', body: JSON.stringify({ toStage }) });
    }
    // DELIVERED (the tap is P4): the copy is under My Returns, the stage at client review.
    const returnFile = `HARNESS-NEXT-1040-RETURN-${viewport}.pdf`;
    await upload(token, { contactId: contact.id, category: 'return_deliverable', taxEngagementId: ret.id, taxYear: String(fixtures.scorp.taxYear) }, returnFile);

    await signIn(page, tokens[tokens.length - 1]!);
    let next = await readNext(page);
    expect(next.step).toBe('f8879_pending');
    expect(next.text).toContain('What happens next');
    expect(next.text).toContain('Your return is ready to review. We will send Form 8879 for your signature next.');
    await expect(page.getByText(returnFile)).toBeVisible();
    await page.screenshot({ path: shot, fullPage: true });

    // THE 8879 SENT THROUGH ADOBE SIGN (R53's record).
    await asStaff(token, `/tax-engagements/${ret.id}/8879-sent`, { method: 'POST', body: JSON.stringify({ method: 'adobe_sign', sentOn: today }) });
    next = await readNext(page);
    expect(next.step).toBe('f8879_adobe_sign');
    expect(next.text).toContain('Look for an email from Adobe Sign with your Form 8879. Your return is filed once you sign.');

    // THE SIGNED 8879 ON FILE.
    await upload(token, { contactId: contact.id, category: 'signed_authorizations', taxEngagementId: ret.id, signedOn: today, preparerPtinHolderId: preparer }, `HARNESS-NEXT-8879-${viewport}.pdf`);
    next = await readNext(page);
    expect(next.step).toBe('f8879_on_file');
    expect(next.text).toContain('We have your signed Form 8879 and are filing your return.');

    // FILED, acknowledgments pending.
    await asStaff(token, `/tax-engagements/${ret.id}/transition`, { method: 'POST', body: JSON.stringify({ toStage: 'ready_to_file' }) });
    await asStaff(token, `/tax-engagements/${ret.id}/transition`, { method: 'POST', body: JSON.stringify({ toStage: 'filed', preparerPtinHolderId: preparer, jurisdictions: ['federal', 'IL'], filingMethods: { IL: 'paper' } }) });
    next = await readNext(page);
    expect(next.step).toBe('filed');
    expect(next.text).toContain('Filed. We will let you know when it is accepted.');

    // THE IRS ACCEPTS; Illinois, declared on paper, is still awaited: the sentence stays "Filed."
    await asStaff(token, `/tax-engagements/${ret.id}/efile-result`, { method: 'POST', body: JSON.stringify({ result: 'accepted', jurisdiction: 'federal', asOf: today }) });
    next = await readNext(page);
    expect(next.step).toBe('filed');

    // ILLINOIS MAILED (the paper lane's acceptance): completed, and the line reads per jurisdiction (R48).
    await asStaff(token, `/tax-engagements/${ret.id}/jurisdictions/IL/mailing`, { method: 'POST', body: JSON.stringify({ mailedOn: today, method: 'first_class', asOf: today }) });
    next = await readNext(page);
    expect(next.step).toBe('accepted');
    const day = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${today}T00:00:00Z`));
    expect(next.text).toContain(`Accepted by the IRS on ${day}. Mailed to Illinois on ${day}.`);
    expect(next.text, 'the one-word line is gone').not.toMatch(/Accepted\.\s*$/);
    const text = await page.evaluate(() => document.body.innerText);
    expect(text, 'no raw key reaches the screen').not.toMatch(/returns_next_|f8879_/);
    expect(text, 'nothing on the page is a raw ISO timestamp').not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    passed = true;
  } finally {
    if (!existsSync(shot)) await page.screenshot({ path: shot, fullPage: true }).catch(() => undefined);
    testInfo.annotations.push({ type: 'screenshot', description: keepScreenshot(`portal-returns-next-${viewport}`, passed, shot) });
    testInfo.annotations.push({ type: 'walk-step', description: `P5|${CONTROL} at ${viewport}: the sentence for 8879 pending after delivery, for sent by Adobe Sign (POST /tax-engagements/:id/8879-sent), for the signed 8879 on file, for filed, and the completed line per jurisdiction ("Accepted by the IRS on <date>. Mailed to Illinois on <date>." after POST /efile-result and POST /jurisdictions/IL/mailing)|client (portal sign-in link); the return walked through the API doors as ceo|tap` });
  }
});
