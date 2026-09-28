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
 *   F5  Correct the filing → "Signed on" moved EARLIER (R69, 2026-09-27): the upload recorded the day
 *       the paper was scanned; the paper is dated two days before. A day after today is refused in the
 *       modal in the route's words and the typed day stays; the paper's day lands and the history line
 *       reads the correction. This is Brian's own shape (his 8879-CORP recorded 2026-09-20, dated
 *       2026-09-15), relative to the fixture's dates.
 *   F6  Correct the filing → "Replace the scan" (R69, amended): a new file goes through /documents and
 *       the correction makes it the 8879 on file; the previous document row is kept, marked
 *       superseded (the Documents card says so), still listed and still downloadable.
 *   F4  Correct the filing → Filed on moved earlier: a day before the CORRECTED signed 8879 is refused
 *       in the modal NAMING THE CORRECTED DAY, and the typed day stays; the corrected signed day itself
 *       lands (the rule is inclusive: filed on the signed day), and the row reads it.
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
  portalPort?: number;
};
const API = `http://127.0.0.1:${fixtures.port}`;
const PORTAL = `http://localhost:${fixtures.portalPort ?? 3106}`;
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
  test('F1–F6: filed on today, then IL removed, the PTIN holder moved with the preparer, the 8879 signed date moved earlier, the scan replaced, the filed date moved to the corrected signed day', async ({ page }, testInfo) => {
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

      // ── F5. THE 8879 SIGNED DATE, MOVED EARLIER TO THE DAY ON THE PAPER (R69) ─────────
      // The upload recorded the day the paper was scanned (ten days ago); the paper is dated twelve.
      const paperSignedOn = addDays(today, -12);
      const reasonF5 = `harness walk ${viewport}: the upload recorded the day the 8879 was scanned; the paper itself is dated ${paperSignedOn}`;
      await returnRow.getByTestId('correct-filing').click();
      await expect(dialog).toBeVisible();
      await expect(dialog.getByLabel('Signed on'), 'opens on the signed day as recorded').toHaveValue(signedOn);
      await expect(dialog.getByTestId('correction-f8879-variant').locator('select'), 'the form on file: an 1120S took 8879-CORP').toHaveValue('8879-CORP');
      await dialog.getByLabel('Signed on').fill(tomorrow);
      await dialog.locator('textarea').fill(reasonF5);
      await dialog.getByRole('button', { name: 'Correct the filing' }).click();
      await expect(dialog.locator('#ask-error'), 'a signed day after today is refused in the modal, in the route\'s words').toContainText('is after today');
      await expect(dialog.getByLabel('Signed on'), 'the day stays for correction').toHaveValue(tomorrow);
      await dialog.getByLabel('Signed on').fill(paperSignedOn);
      await dialog.getByRole('button', { name: 'Correct the filing' }).click();
      await expect(dialog).toHaveCount(0);
      await expect(history.locator('li')).toHaveCount(3);
      await expect(history.locator('li').nth(2)).toContainText(`Corrected the 8879 signed date on ${dayText(today)} by ${me.fullName}: ${reasonF5}`);
      const afterF5 = (await read(page, `/tax-engagements/${te}`)).taxEngagement as Record<string, unknown>;
      expect(afterF5.f8879_signed_on, 'the return reads the corrected signed day where the filed-date rule reads it').toBe(paperSignedOn);
      steps.push(`F5|/clients/:id Returns card, filed row, button "Correct the filing" (modal: "Signed on" opening on the recorded day; ${tomorrow} refused "is after today" at #ask-error with the day kept; ${paperSignedOn} lands); the history line reads "Corrected the 8879 signed date on <day> by <who>: <reason>"|${ROLES}|tap`);

      // ── F6. THE SCAN REPLACED; THE OLD ROW KEPT AND MARKED (R69, amended) ─────────────
      const oldScan = String(afterF5.f8879_document_id);
      const reasonF6 = `harness walk ${viewport}: the first upload was the unsigned copy; this is the signed 8879-CORP as it sits in the file`;
      await returnRow.getByTestId('correct-filing').click();
      await expect(dialog).toBeVisible();
      await dialog.getByTestId('correction-f8879-scan').setInputFiles({ name: `HARNESS-CORRECTIONS-8879-REPLACEMENT-${viewport}.pdf`, ...PDF });
      await dialog.locator('textarea').fill(reasonF6);
      await dialog.getByRole('button', { name: 'Correct the filing' }).click();
      await expect(dialog).toHaveCount(0);
      await expect(history.locator('li')).toHaveCount(4);
      await expect(history.locator('li').nth(3)).toContainText(`Corrected the 8879 scan on ${dayText(today)} by ${me.fullName}: ${reasonF6}`);
      const afterF6 = (await read(page, `/tax-engagements/${te}`)).taxEngagement as Record<string, unknown>;
      expect(afterF6.f8879_document_id, 'the return points at the new scan').not.toBe(oldScan);
      expect(afterF6.f8879_signed_on, 'the corrected signed day stands on the new scan').toBe(paperSignedOn);
      const docs = (await read(page, `/documents?contactId=${contactId}`)).documents as Array<Record<string, unknown>>;
      const oldRow = docs.find((d) => d.id === oldScan);
      expect(oldRow, 'the old row is still listed').toBeTruthy();
      expect(oldRow!.superseded_by, 'and marked with what replaced it').toBe(afterF6.f8879_document_id);
      expect(oldRow!.superseded_at, 'and when').toBeTruthy();
      const download = await page.evaluate(async (id) => (await fetch(`/api/documents/${id}/download`)).status, oldScan);
      expect(download, 'the superseded scan still downloads').toBe(200);
      await page.goto(clientPage);
      await expect(page.getByRole('heading', { name: 'Returns' })).toBeVisible();
      await expect(page.getByTestId(`document-superseded-${oldScan}`), 'the Documents card reads the old row as superseded').toContainText('superseded');
      steps.push(`F6|/clients/:id Returns card, filed row, button "Correct the filing" (modal: input[type=file] "Replace the scan", required Reason); the new scan is the 8879 on file, the Documents card row for the old scan reads "superseded", GET /documents lists it with superseded_by and it still downloads (200)|${ROLES}|tap`);

      // ── F4. MOVE THE FILED DATE EARLIER — TO THE CORRECTED SIGNED DAY ─────────────────
      const reasonF4 = `harness walk ${viewport}: the transmission record shows the return went in the day the 8879 was signed, not the day it was marked here`;
      await returnRow.getByTestId('correct-filing').click();
      await expect(dialog).toBeVisible();
      await expect(dialog.getByLabel('Filed on'), 'opens on the day as recorded').toHaveValue(today);
      await dialog.getByLabel('Filed on').fill(addDays(paperSignedOn, -1));
      await dialog.locator('textarea').fill(reasonF4);
      await dialog.getByRole('button', { name: 'Correct the filing' }).click();
      await expect(dialog.locator('#ask-error'), 'a day before the CORRECTED signed 8879 is refused in the modal, naming the corrected day').toContainText(`before the signed 8879 dated ${paperSignedOn}`);
      await expect(dialog.getByLabel('Filed on'), 'the day stays for correction').toHaveValue(addDays(paperSignedOn, -1));
      await expect(dialog.locator('textarea'), 'and so does the reason').toHaveValue(reasonF4);
      await dialog.getByLabel('Filed on').fill(paperSignedOn);
      await dialog.getByRole('button', { name: 'Correct the filing' }).click();
      await expect(dialog).toHaveCount(0);
      await expect(returnRow.getByText(`filed ${dayText(paperSignedOn)}`, { exact: false }), 'the row reads the corrected day: filed on the signed day is allowed').toBeVisible();
      await expect(history.locator('li')).toHaveCount(5);
      await expect(history.locator('li').nth(4)).toContainText(`Corrected the filed date on ${dayText(today)} by ${me.fullName}: ${reasonF4}`);
      const afterF4 = (await read(page, `/tax-engagements/${te}`)).taxEngagement as Record<string, unknown>;
      expect(afterF4.filed_date, 'the return carries the corrected calendar day').toBe(paperSignedOn);
      expect(afterF4.filed_date, 'signed and filed on the same day, Brian\'s shape').toBe(afterF4.f8879_signed_on);
      steps.push(`F4|/clients/:id Returns card, filed row, button "Correct the filing" (modal: "Filed on" moved earlier; ${addDays(paperSignedOn, -1)} refused "before the signed 8879 dated ${paperSignedOn}" — the CORRECTED day — at #ask-error with the day and the reason kept; the corrected signed day lands, inclusive); the row reads "filed <day>" and the history line the correction|${ROLES}|tap`);

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

  /*
   * R86 (Brian, 2026-09-27): Brian's two pending corrections, on a COMPLETED return — his 1120S was
   * completed before they could run. F7 the signed day moved to the day on the paper with the real scan
   * beside it; F8 the filed day moved to that same day; a jurisdiction that answered is refused in the
   * modal. F9 (R88) the client reads the corrected day on the portal as that calendar day, in Chicago:
   * the day stored as midnight UTC once read a day early there.
   */
  test.describe('on a completed return (R86, R88)', () => {
    test.use({ timezoneId: 'America/Chicago' });
    test('F7–F9: the signed day with its scan and the filed day corrected on a completed return; an answered jurisdiction refused; the portal reads the corrected day', async ({ page }, testInfo) => {
      const viewport = testInfo.project.name;
      test.setTimeout(300_000);
      const shot = testInfo.outputPath(`filing-corrections-completed-${viewport}.png`);
      const steps: string[] = [];
      let passed = false;
      try {
        const token = await staffToken();
        const me = await asStaff<{ id: string; fullName: string }>(token, '/auth/me');
        const { contactId, te, signedOn } = await readyToFileReturn(token, viewport, 'done');
        // Filed federal and IL, both accepted: the return completes, as Brian's did.
        await asStaff(token, `/tax-engagements/${te}/transition`, { method: 'POST', body: JSON.stringify({ toStage: 'filed', preparerPtinHolderId: fixtures.scorp.preparer.id, jurisdictions: ['federal', 'IL'] }) });
        await asStaff(token, `/tax-engagements/${te}/efile-result`, { method: 'POST', body: JSON.stringify({ result: 'accepted' }) });
        await asStaff(token, `/tax-engagements/${te}/efile-result`, { method: 'POST', body: JSON.stringify({ result: 'accepted', jurisdiction: 'state', stateCode: 'IL' }) });
        const done = (await asStaff<{ taxEngagement: { stage: string } }>(token, `/tax-engagements/${te}`)).taxEngagement;
        expect(done.stage, 'the fixture is completed').toBe('completed');

        const dialog = page.locator('[role=dialog]');
        const returnRow = page.locator('.quote-line', { has: page.getByTestId('correct-filing') });
        await signIn(page, fixtures.staff);
        await page.goto(`/clients/${contactId}`);
        await page.waitForLoadState('networkidle');
        await expect(returnRow, 'the completed row offers Correct the filing').toBeVisible();

        // ── F7. SIGNED ON, TO THE DAY ON THE PAPER, WITH THE REAL SCAN ──────────────────
        const paperDay = addDays(today, -12);
        const reasonF7 = `harness walk ${viewport}: the 8879 was recorded on the day it was scanned; the paper is dated ${paperDay}, and this is the signed scan`;
        await returnRow.getByTestId('correct-filing').click();
        await expect(dialog).toBeVisible();
        await expect(dialog.getByLabel('Signed on'), 'opens on the day as recorded').toHaveValue(signedOn);
        await dialog.getByLabel('Signed on').fill(paperDay);
        await dialog.getByTestId('correction-f8879-scan').setInputFiles({ name: `HARNESS-COMPLETED-8879-REAL-${viewport}.pdf`, ...PDF });
        await dialog.locator('textarea').fill(reasonF7);
        await dialog.getByRole('button', { name: 'Correct the filing' }).click();
        await expect(dialog).toHaveCount(0);
        const afterF7 = (await asStaff<{ taxEngagement: Record<string, unknown> }>(token, `/tax-engagements/${te}`)).taxEngagement;
        expect(afterF7.f8879_signed_on).toBe(paperDay);
        expect(afterF7.stage, 'correcting the record is not reopening the return').toBe('completed');
        steps.push(`F7|/clients/:id Returns card, COMPLETED row, button "Correct the filing" (modal: "Signed on" moved to the day on the paper + input[type=file] "Replace the scan", required Reason); the return stays completed|${ROLES}|tap`);

        // ── F8. FILED ON, TO THE SAME DAY; A JURISDICTION THAT ANSWERED IS REFUSED ─────────
        const reasonF8 = `harness walk ${viewport}: the return went in on the day the 8879 was signed`;
        await returnRow.getByTestId('correct-filing').click();
        await expect(dialog).toBeVisible();
        // IL answered this return: the modal offers no Remove for it, and says it stays (the route refuses it too).
        await expect(dialog.getByRole('button', { name: 'Remove IL' }), 'no Remove for a jurisdiction that answered').toHaveCount(0);
        await expect(dialog.getByText(/stays on the filing/).first(), 'it says the answered jurisdiction stays').toBeVisible();
        await dialog.getByLabel('Filed on').fill(paperDay);
        await dialog.locator('textarea').fill(reasonF8);
        await dialog.getByRole('button', { name: 'Correct the filing' }).click();
        await expect(dialog).toHaveCount(0);
        const afterF8 = (await asStaff<{ taxEngagement: Record<string, unknown> }>(token, `/tax-engagements/${te}`)).taxEngagement;
        expect(afterF8.filed_date, 'filed on the signed day, Brian\'s shape').toBe(paperDay);
        expect(afterF8.stage).toBe('completed');
        steps.push(`F8|/clients/:id Returns card, COMPLETED row, button "Correct the filing" (modal: IL, which answered, reads "… stays on the filing" with no Remove chip; "Filed on" moved to the corrected signed day, required Reason); the return stays completed|${ROLES}|tap`);

        // ── F9 (R88). THE CLIENT READS THE CORRECTED DAY, AS THAT DAY, IN CHICAGO ─────────
        const before = ((await (await fetch(`${API}/harness/mail-links`)).json()) as { magicTokens: string[] }).magicTokens.length;
        await asStaff(token, '/portal-users', { method: 'POST', body: JSON.stringify({ contactId }) });
        await expect.poll(async () => ((await (await fetch(`${API}/harness/mail-links`)).json()) as { magicTokens: string[] }).magicTokens.length).toBeGreaterThan(before);
        const tokens = ((await (await fetch(`${API}/harness/mail-links`)).json()) as { magicTokens: string[] }).magicTokens;
        await page.goto(`${PORTAL}/login`);
        const status = await page.evaluate(async (t) => {
          const r = await fetch('/api/portal/auth/magic/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: t }) });
          localStorage.setItem('saos_portal_authed', '1');
          return r.status;
        }, tokens[tokens.length - 1]!);
        expect(status).toBe(200);
        await page.goto(`${PORTAL}/sign`);
        await page.waitForLoadState('networkidle');
        const signedRow = page.getByTestId('envelope-row').filter({ hasText: /Signed on/ }).first();
        await expect(signedRow, 'the 8879 reads the corrected calendar day, not the day before').toContainText(`Signed on ${dayText(paperDay)}`);
        await page.screenshot({ path: shot, fullPage: true });
        steps.push(`F9|portal /sign (the client, signed in by the link they were emailed; browser zone America/Chicago): the 8879 row reads "Signed on ${dayText(paperDay)}", the corrected calendar day (R88)|the client|tap`);
        void me;
        passed = true;
      } finally {
        if (!existsSync(shot)) await page.screenshot({ path: shot, fullPage: true }).catch(() => undefined);
        testInfo.annotations.push({ type: passed ? 'artifact' : 'failure-screenshot', description: keepScreenshot(`filing-corrections-completed-${viewport}`, passed, shot) });
        for (const st of steps) testInfo.annotations.push({ type: 'walk-step', description: st });
      }
    });
  });
});
