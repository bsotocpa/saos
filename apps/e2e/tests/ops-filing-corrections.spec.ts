/*
 * FILED ON, AND THE FILING CORRECTED (Brian, 2026-09-26) — path F, at 390 × 844 and 1280 × 800.
 *
 * Brian will make three corrections on his own 1120S: remove a jurisdiction, change the PTIN holder,
 * move the filed date earlier. This is that walk, on a synthetic 1120S the spec opens for each
 * viewport through the doors the API already has (the return record, the signed engagement letter,
 * the estimate lock, the stages, the signed 8879 — none of them the subject here), and then taps:
 *
 *   F1  Mark filed takes "Filed on": it opens on today; a day after today is refused in the modal in
 *       the route's words and the day typed stays; a day before the signed 8879 is refused the same
 *       way; today files, and the row reads the day.
 *   F2  Correct the filing → Remove IL, with a reason: the jurisdiction line for IL leaves the row and
 *       the history line under the row says what was corrected, when, by whom and why.
 *   F3  Correct the filing → the PTIN holder becomes the CEO; the offer to move the assigned preparer
 *       appears CHECKED, because the holder and the assignee were the same person; both move.
 *   F4  Correct the filing → Filed on moved earlier: a day before the signed 8879 is refused in the
 *       modal and the typed day stays; the day on the 8879 itself lands, and the row reads it.
 *
 * ROLE PROOF: the bookkeeper holds no engagements.tax.manage. No "Correct the filing" control renders
 * for her anywhere on the page, and POST /tax-engagements/:id/filing-corrections answers 403 from
 * her own session.
 *
 * Each viewport opens its own return: the two projects run sequentially against ONE harness database,
 * and a return corrected by the phone would have nothing left for the desk to correct.
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
  staff: Persona;
  scorp: { taxYear: number; preparer: { id: string; name: string } };
  wall: { bookkeeper: Persona };
};
const API = `http://127.0.0.1:${fixtures.port}`;
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
const ROLES = 'tax_preparer, ceo (engagements.tax.manage)';
const PDF = { mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 synthetic harness document — no real client data\n%%EOF') };

/** A calendar day shifted by n days, as YYYY-MM-DD, no zone. */
const addDays = (iso: string, n: number): string => {
  const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
/**
 * A calendar day in the words Ops prints it — the same Intl call apps/internal/lib/dates.ts makes,
 * written out here so a change to the formatter cannot agree with itself.
 */
const dayText = (iso: string): string =>
  new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(`${iso.slice(0, 10)}T00:00:00Z`));
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
/** One signed paper into Signed Authorizations against the return — the same multipart door the row's upload uses. */
async function uploadSigned(token: string, fields: Record<string, string>, filename: string): Promise<void> {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  fd.append('file', new Blob([PDF.buffer], { type: PDF.mimeType }), filename);
  const r = await fetch(`${API}/documents`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: fd });
  const body = await r.json().catch(() => ({}));
  expect(r.status, `upload ${filename}: ${JSON.stringify(body)}`).toBeLessThan(300);
}
/** A read of the API from the signed-in session, for assertions on state the screen does not print. */
async function read(page: Page, path: string): Promise<Record<string, unknown>> {
  return page.evaluate(async (p) => (await fetch(`/api${p}`)).json().catch(() => ({})), path);
}
/**
 * A synthetic 1120S at ready_to_file, through the doors: a new contact, the return record (opened by
 * hand with a reason — no quote stands behind it), the signed engagement letter, the estimate lock,
 * the stages, and the signed 8879 dated ten days ago with the fixture preparer's PTIN on it.
 */
async function readyToFileReturn(token: string, viewport: string, tag: string): Promise<{ contactId: string; te: string; signedOn: string }> {
  const contact = await asStaff<{ id: string }>(token, '/contacts', {
    method: 'POST',
    body: JSON.stringify({ firstName: 'Synthetic', lastName: `Corrections${tag}${viewport === 'desk' ? 'Desk' : 'Phone'}`, email: `corrections-${tag}-${viewport}@example.test` }),
  });
  const ret = await asStaff<{ id: string }>(token, '/tax-engagements', {
    method: 'POST',
    body: JSON.stringify({
      contactId: contact.id, taxYear: fixtures.scorp.taxYear, returnType: '1120s', clientType: 'business',
      preparerId: fixtures.scorp.preparer.id,
      reason: 'Harness walk: a return opened by hand so the filing can be corrected; no quote stands behind it.',
    }),
  });
  await uploadSigned(token, { contactId: contact.id, category: 'signed_authorizations', taxEngagementId: ret.id, engagementLetterSignedOn: today }, `HARNESS-CORRECTIONS-LETTER-${viewport}.pdf`);
  await asStaff(token, `/tax-engagements/${ret.id}/estimate`, { method: 'POST', body: JSON.stringify({ minCents: 60000, maxCents: 80000 }) });
  // R50: the stepper orders the fee before ready to file, so the row offers Mark filed once it is set; inside the range, no reason.
  await asStaff(token, `/tax-engagements/${ret.id}/final-fee`, { method: 'POST', body: JSON.stringify({ finalFeeCents: 70000 }) });
  for (const toStage of ['scheduled', 'documents_requested', 'in_preparation', 'internal_review', 'client_review', 'ready_to_file']) {
    await asStaff(token, `/tax-engagements/${ret.id}/transition`, { method: 'POST', body: JSON.stringify({ toStage }) });
  }
  const signedOn = addDays(today, -10);
  await uploadSigned(token, { contactId: contact.id, category: 'signed_authorizations', taxEngagementId: ret.id, signedOn, preparerPtinHolderId: fixtures.scorp.preparer.id }, `HARNESS-CORRECTIONS-8879-${viewport}.pdf`);
  return { contactId: contact.id, te: ret.id, signedOn };
}
function keepScreenshot(name: string, passed: boolean, file: string): string {
  const dir = passed ? resolve(here, '..', '.artifacts', today) : resolve(root, 'tasks', 'walks', today);
  mkdirSync(dir, { recursive: true });
  const target = resolve(dir, `${name}.png`);
  if (existsSync(file)) copyFileSync(file, target);
  return target;
}

test.describe('Ops → Filed on, and the filing corrected', () => {
  test('F1–F4: filed on today, then IL removed, the PTIN holder moved with the preparer, the filed date moved earlier', async ({ page }, testInfo) => {
    const viewport = testInfo.project.name;
    test.setTimeout(300_000);
    const shot = testInfo.outputPath(`filing-corrections-${viewport}.png`);
    const steps: string[] = [];
    let passed = false;
    try {
      const token = await staffToken();
      const me = await asStaff<{ id: string; fullName: string }>(token, '/auth/me');
      const { contactId, te, signedOn } = await readyToFileReturn(token, viewport, 'walk');
      const clientPage = `/clients/${contactId}`;
      const dialog = page.locator('[role=dialog]');
      const returnRow = page.locator('.quote-line', { has: page.getByTestId('correct-filing') });

      await signIn(page, fixtures.staff);
      await page.goto(clientPage);
      await expect(page.getByRole('heading', { name: 'Returns' })).toBeVisible();

      // ── F1. MARK FILED, WITH "FILED ON" ─────────────────────────────────────────────────
      await page.getByRole('button', { name: 'Mark filed' }).click();
      await expect(dialog).toBeVisible();
      await expect(dialog.getByLabel('Filed on'), 'the day opens on today, in Chicago').toHaveValue(today);
      await expect(dialog.getByLabel(/PTIN holder/), 'the PTIN holder is the one on the signed 8879').toHaveValue(fixtures.scorp.preparer.id);
      // The state this return also files in: added here, the way the walk adds one.
      await dialog.getByLabel('Add a state (two-letter code)').fill('IL');
      await dialog.getByRole('button', { name: 'Add state' }).click();
      await expect(dialog.getByTestId('filing-method-IL'), 'IL is on the list, on the lane this year has').toHaveValue('efile');
      // A day after today: refused in the modal, in the route's words, and the day typed stays.
      const tomorrow = addDays(today, 1);
      await dialog.getByLabel('Filed on').fill(tomorrow);
      await dialog.getByRole('button', { name: 'Mark filed' }).click();
      await expect(dialog.locator('#ask-error'), 'refused beside the field, in the server\'s words').toContainText('is after today');
      await expect(dialog.getByLabel('Filed on'), 'the day stays for correction').toHaveValue(tomorrow);
      // A day before the signed 8879: refused the same way.
      await dialog.getByLabel('Filed on').fill(addDays(signedOn, -1));
      await dialog.getByRole('button', { name: 'Mark filed' }).click();
      await expect(dialog.locator('#ask-error')).toContainText(`before the signed 8879 dated ${signedOn}`);
      await expect(dialog.getByLabel('Filed on')).toHaveValue(addDays(signedOn, -1));
      // Today files.
      await dialog.getByLabel('Filed on').fill(today);
      await dialog.getByRole('button', { name: 'Mark filed' }).click();
      await expect(dialog).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Mark filed' }), 'the pre-filing controls leave with the filing').toHaveCount(0);
      await expect(returnRow, 'the filed row carries the correction control').toBeVisible();
      await expect(returnRow.getByText(`filed ${dayText(today)}`, { exact: false })).toBeVisible();
      await expect(returnRow.getByTestId('jurisdiction-line-IL')).toBeVisible();
      const filed = (await read(page, `/tax-engagements/${te}`)).taxEngagement as Record<string, unknown>;
      expect(filed.stage).toBe('filed');
      expect(filed.filed_date, 'a calendar day, today in Chicago').toBe(today);
      steps.push(`F1|/clients/:id Returns card, button "Mark filed" (modal: "Filed on" date opening on today; ${tomorrow} refused "is after today" and ${addDays(signedOn, -1)} refused "before the signed 8879" at #ask-error with the day kept; today files)|${ROLES}|tap`);

      // ── F2. REMOVE A JURISDICTION ──────────────────────────────────────────────────────
      const reasonF2 = `harness walk ${viewport}: the Illinois return was never part of this filing; the entity has no Illinois nexus for the year`;
      await returnRow.getByTestId('correct-filing').click();
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole('heading', { name: 'Correct the filing' })).toBeVisible();
      await expect(dialog.getByRole('button', { name: 'Correct the filing' }), 'the reason is the record: the button waits for it').toBeDisabled();
      await dialog.getByRole('button', { name: 'Remove IL' }).click();
      await expect(dialog.getByRole('button', { name: 'Remove IL' })).toHaveCount(0);
      await dialog.locator('textarea').fill(reasonF2);
      await dialog.getByRole('button', { name: 'Correct the filing' }).click();
      await expect(dialog).toHaveCount(0);
      await expect(returnRow.getByTestId('jurisdiction-line-IL'), 'IL left the row').toHaveCount(0);
      await expect(returnRow.getByTestId('jurisdiction-line-federal')).toBeVisible();
      const history = returnRow.getByTestId(`filing-history-${te}`);
      await expect(history.locator('li'), 'one correction under the row').toHaveCount(1);
      await expect(history.locator('li').nth(0)).toContainText(`Corrected the declared jurisdictions on ${dayText(today)} by ${me.fullName}: ${reasonF2}`);
      const afterF2 = (await read(page, `/tax-engagements/${te}`)) as { declared_jurisdictions: string[] };
      expect(afterF2.declared_jurisdictions, 'the return now declares federal alone').toEqual(['federal']);
      steps.push(`F2|/clients/:id Returns card, filed row, button "Correct the filing" (modal: chip "Remove IL", required Reason), button "Correct the filing"; the IL line leaves the row and the history line reads "Corrected the declared jurisdictions on <day> by <who>: <reason>"|${ROLES}|tap`);

      // ── F3. CHANGE THE PTIN HOLDER, WITH THE PREPARER OFFER ────────────────────────────
      const reasonF3 = `harness walk ${viewport}: the CEO signed this return with his own PTIN; the preparer was picked from the list by mistake`;
      await returnRow.getByTestId('correct-filing').click();
      await expect(dialog).toBeVisible();
      await expect(dialog.getByTestId('also-assign-preparer'), 'no offer until the holder changes').toHaveCount(0);
      await dialog.getByLabel('PTIN holder').selectOption(me.id);
      const offer = dialog.getByTestId('also-assign-preparer');
      await expect(offer, 'the offer appears with the change').toBeVisible();
      await expect(offer, 'checked, because the holder and the assignee were the same person').toBeChecked();
      await expect(dialog.getByText(`Also make ${me.fullName} the assigned preparer`)).toBeVisible();
      await dialog.locator('textarea').fill(reasonF3);
      await dialog.getByRole('button', { name: 'Correct the filing' }).click();
      await expect(dialog).toHaveCount(0);
      await expect(returnRow.getByText(`preparer of record: ${me.fullName}`, { exact: false }), 'the row names the corrected holder').toBeVisible();
      await expect(history.locator('li')).toHaveCount(2);
      await expect(history.locator('li').nth(1)).toContainText(`Corrected the PTIN holder on ${dayText(today)} by ${me.fullName}: ${reasonF3}`);
      const afterF3 = (await read(page, `/tax-engagements/${te}`)) as { taxEngagement: Record<string, unknown>; assigned_preparer: { id: string } | null };
      expect(afterF3.taxEngagement.preparer_ptin_holder_id, 'the PTIN holder moved').toBe(me.id);
      expect(afterF3.assigned_preparer?.id, 'and the assigned preparer moved with it, through the assign door').toBe(me.id);
      steps.push(`F3|/clients/:id Returns card, filed row, button "Correct the filing" (modal: "PTIN holder" select → the CEO; checkbox "Also make … the assigned preparer" appears checked; required Reason); the row reads the new preparer of record and the assignee follows|${ROLES}|tap`);

      // ── F4. MOVE THE FILED DATE EARLIER ────────────────────────────────────────────────
      const reasonF4 = `harness walk ${viewport}: the transmission record shows the return went in the day the 8879 was signed, not the day it was marked here`;
      await returnRow.getByTestId('correct-filing').click();
      await expect(dialog).toBeVisible();
      await expect(dialog.getByLabel('Filed on'), 'opens on the day as recorded').toHaveValue(today);
      await dialog.getByLabel('Filed on').fill(addDays(signedOn, -1));
      await dialog.locator('textarea').fill(reasonF4);
      await dialog.getByRole('button', { name: 'Correct the filing' }).click();
      await expect(dialog.locator('#ask-error'), 'a day before the signed 8879 is refused in the modal').toContainText(`before the signed 8879 dated ${signedOn}`);
      await expect(dialog.getByLabel('Filed on'), 'the day stays for correction').toHaveValue(addDays(signedOn, -1));
      await expect(dialog.locator('textarea'), 'and so does the reason').toHaveValue(reasonF4);
      await dialog.getByLabel('Filed on').fill(signedOn);
      await dialog.getByRole('button', { name: 'Correct the filing' }).click();
      await expect(dialog).toHaveCount(0);
      await expect(returnRow.getByText(`filed ${dayText(signedOn)}`, { exact: false }), 'the row reads the corrected day').toBeVisible();
      await expect(history.locator('li')).toHaveCount(3);
      await expect(history.locator('li').nth(2)).toContainText(`Corrected the filed date on ${dayText(today)} by ${me.fullName}: ${reasonF4}`);
      const afterF4 = (await read(page, `/tax-engagements/${te}`)).taxEngagement as Record<string, unknown>;
      expect(afterF4.filed_date, 'the return carries the corrected calendar day').toBe(signedOn);
      steps.push(`F4|/clients/:id Returns card, filed row, button "Correct the filing" (modal: "Filed on" moved earlier; ${addDays(signedOn, -1)} refused "before the signed 8879" at #ask-error with the day and the reason kept; the 8879's day lands); the row reads "filed <day>" and the history line the correction|${ROLES}|tap`);

      await page.screenshot({ path: shot, fullPage: true });
      passed = true;
    } finally {
      if (!existsSync(shot)) await page.screenshot({ path: shot, fullPage: true }).catch(() => undefined);
      testInfo.annotations.push({ type: passed ? 'artifact' : 'failure-screenshot', description: keepScreenshot(`filing-corrections-${viewport}`, passed, shot) });
      for (const s of steps) testInfo.annotations.push({ type: 'walk-step', description: s });
    }
  });

  test('role proof: the bookkeeper has no Correct the filing control and the route refuses her', async ({ page }, testInfo) => {
    const viewport = testInfo.project.name;
    const token = await staffToken();
    const { contactId, te } = await readyToFileReturn(token, viewport, 'wall');
    // Filed through the API door with the day unsaid — the default is the subject of F1, not of this proof.
    await asStaff(token, `/tax-engagements/${te}/transition`, {
      method: 'POST', body: JSON.stringify({ toStage: 'filed', preparerPtinHolderId: fixtures.scorp.preparer.id, jurisdictions: ['federal', 'IL'] }),
    });

    await signIn(page, fixtures.wall.bookkeeper);
    await page.goto(`/clients/${contactId}`);
    await expect(page.getByRole('heading', { name: 'Returns' })).toBeVisible();
    await page.waitForTimeout(800);
    await expect(page.getByTestId('correct-filing'), 'no Correct the filing control anywhere on her page').toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Correct the filing' })).toHaveCount(0);

    const refused = await page.evaluate(async (id) => {
      const r = await fetch(`/api/tax-engagements/${id}/filing-corrections`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jurisdictions: ['federal'], reason: 'A role proof: this correction must be refused for a role without the permission.' }),
      });
      return r.status;
    }, te);
    expect(refused, 'the correction door refuses a role without engagements.tax.manage').toBe(403);
    const after = await asStaff<{ declared_jurisdictions: string[] }>(token, `/tax-engagements/${te}`);
    expect(after.declared_jurisdictions, 'nothing moved').toEqual(['federal', 'IL']);
    testInfo.annotations.push({ type: 'walk-step', description: `F2|role proof: bookkeeper sees no "Correct the filing" control on /clients/:id, POST /tax-engagements/:id/filing-corrections refused 403|${ROLES}|tap` });
  });
});
