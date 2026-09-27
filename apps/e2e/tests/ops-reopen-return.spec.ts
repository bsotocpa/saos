/*
 * REOPEN A COMPLETED RETURN (Brian, 2026-09-26, R67) — path R, at 390 × 844 and 1280 × 800.
 *
 * A completed return had no door out. The CEO alone may reopen it, with a reason: the return goes
 * back to filed, the engagement to active, the executive count follows, and nothing completes it
 * again until a NEW acceptance (or mailing) is recorded. Each viewport opens its own synthetic 1120S
 * through the doors the API already has (the return record, the letter, the lock, the fee, the
 * stages, the signed 8879, filed federal-only, accepted by the IRS — none of them the subject here)
 * and then taps:
 *
 *   R1  "Reopen…" on the completed row → a modal with one required reason → the row reads filed and
 *       "Reopened", with the reason.
 *   R2  The engagement is active again (read through the session), and the executive view's "filed"
 *       count is one higher than before the tap.
 *   R3  A forced completion is refused (409 jurisdictions_awaiting, in the route's words); a new
 *       acceptance through the e-file result door completes it and the engagement closes again.
 *
 * ROLE PROOF: the tax preparer holds engagements.tax.manage and every return control, but not
 * engagements.tax.reopen (explicit-only; the wildcard does not confer it either). On a second
 * completed return she sees no Reopen control anywhere on the page, and POST
 * /tax-engagements/:id/reopen answers 403 from her own session, in the server's words.
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
  wall: { anamaria: Persona };
};
const API = `http://127.0.0.1:${fixtures.port}`;
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
const ROLES = 'ceo (engagements.tax.reopen, explicit-only)';
const PDF = { mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 synthetic harness document - no real client data\n%%EOF') };
const addDays = (iso: string, n: number): string => {
  const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

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
async function uploadSigned(token: string, fields: Record<string, string>, filename: string): Promise<void> {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  fd.append('file', new Blob([PDF.buffer], { type: PDF.mimeType }), filename);
  const r = await fetch(`${API}/documents`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: fd });
  const body = await r.json().catch(() => ({}));
  expect(r.status, `upload ${filename}: ${JSON.stringify(body)}`).toBeLessThan(300);
}
async function read(page: Page, path: string): Promise<Record<string, unknown>> {
  return page.evaluate(async (p) => (await fetch(`/api${p}`)).json().catch(() => ({})), path);
}
/**
 * A completed 1120S through the doors: a new contact (no state, so federal is the only jurisdiction),
 * the return, the letter, the lock, the fee, the stages, the signed 8879, filed, accepted by the IRS.
 */
async function completedReturn(token: string, viewport: string, tag: string): Promise<{ contactId: string; te: string }> {
  const contact = await asStaff<{ id: string }>(token, '/contacts', {
    method: 'POST',
    body: JSON.stringify({ firstName: 'Synthetic', lastName: `Reopen${tag}${viewport === 'desk' ? 'Desk' : 'Phone'}`, email: `reopen-${tag}-${viewport}@example.test` }),
  });
  const ret = await asStaff<{ id: string }>(token, '/tax-engagements', {
    method: 'POST',
    body: JSON.stringify({
      contactId: contact.id, taxYear: fixtures.scorp.taxYear, returnType: '1120s', clientType: 'business',
      preparerId: fixtures.scorp.preparer.id,
      reason: 'Harness walk: a return opened by hand so a completed return exists to reopen; no quote stands behind it.',
    }),
  });
  await uploadSigned(token, { contactId: contact.id, category: 'signed_authorizations', taxEngagementId: ret.id, engagementLetterSignedOn: today }, `HARNESS-REOPEN-LETTER-${tag}-${viewport}.pdf`);
  await asStaff(token, `/tax-engagements/${ret.id}/estimate`, { method: 'POST', body: JSON.stringify({ minCents: 60000, maxCents: 80000 }) });
  await asStaff(token, `/tax-engagements/${ret.id}/final-fee`, { method: 'POST', body: JSON.stringify({ finalFeeCents: 70000 }) });
  for (const toStage of ['scheduled', 'documents_requested', 'in_preparation', 'internal_review', 'client_review', 'ready_to_file']) {
    await asStaff(token, `/tax-engagements/${ret.id}/transition`, { method: 'POST', body: JSON.stringify({ toStage }) });
  }
  await uploadSigned(token, { contactId: contact.id, category: 'signed_authorizations', taxEngagementId: ret.id, signedOn: addDays(today, -10), preparerPtinHolderId: fixtures.scorp.preparer.id }, `HARNESS-REOPEN-8879-${tag}-${viewport}.pdf`);
  await asStaff(token, `/tax-engagements/${ret.id}/transition`, {
    method: 'POST', body: JSON.stringify({ toStage: 'filed', preparerPtinHolderId: fixtures.scorp.preparer.id, jurisdictions: ['federal'] }),
  });
  const accepted = await asStaff<{ stage: string }>(token, `/tax-engagements/${ret.id}/efile-result`, { method: 'POST', body: JSON.stringify({ result: 'accepted' }) });
  expect(accepted.stage, 'the IRS acceptance completes the federal-only return').toBe('completed');
  return { contactId: contact.id, te: ret.id };
}
async function filedCount(token: string): Promise<number> {
  const d = await asStaff<{ openReturnsByStage: Array<{ stage: string; count: number }> }>(token, '/dashboards/executive');
  const row = d.openReturnsByStage.find((s) => s.stage === 'filed');
  return row ? Number(row.count) : 0;
}
function keepScreenshot(name: string, passed: boolean, file: string): string {
  const dir = passed ? resolve(here, '..', '.artifacts', today) : resolve(root, 'tasks', 'walks', today);
  mkdirSync(dir, { recursive: true });
  const target = resolve(dir, `${name}.png`);
  if (existsSync(file)) copyFileSync(file, target);
  return target;
}

test.describe('Ops → Reopen a completed return', () => {
  test('R1–R3: reopened with a reason, the engagement active and the count up, re-completion refused until a new acceptance', async ({ page }, testInfo) => {
    const viewport = testInfo.project.name;
    test.setTimeout(300_000);
    const shot = testInfo.outputPath(`reopen-return-${viewport}.png`);
    const steps: string[] = [];
    let passed = false;
    try {
      const token = await staffToken();
      const { contactId, te } = await completedReturn(token, viewport, 'walk');
      const engagementsBefore = (await asStaff<{ engagements: Array<Record<string, unknown>> }>(token, `/engagements?contactId=${contactId}`)).engagements;
      expect(engagementsBefore.find((e) => e.service_line === 'tax')!.status, 'the acceptance closed the engagement').toBe('completed');
      const countBefore = await filedCount(token);
      const clientPage = `/clients/${contactId}`;
      const dialog = page.locator('[role=dialog]');
      const returnRow = page.locator('.quote-line', { has: page.getByTestId('reopen-return') });

      await signIn(page, fixtures.staff);
      await page.goto(clientPage);
      await expect(page.getByRole('heading', { name: 'Returns' })).toBeVisible();
      await expect(returnRow, 'the completed row carries the one control the CEO holds').toBeVisible();
      await expect(returnRow.locator('.badge', { hasText: /^completed$/ }).first(), 'the stage badge reads completed').toBeVisible();

      // ── R1. REOPEN, WITH A REASON ──────────────────────────────────────────────────────
      const reason = `harness walk ${viewport}: the acknowledgment that completed this return belonged to the amended filing; the original still awaits the IRS`;
      await returnRow.getByTestId('reopen-return').click();
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole('heading', { name: 'Reopen this return' })).toBeVisible();
      await expect(dialog.getByRole('button', { name: 'Reopen the return' }), 'the reason is the record: the button waits for it').toBeDisabled();
      await dialog.locator('textarea').fill(reason);
      await dialog.getByRole('button', { name: 'Reopen the return' }).click();
      await expect(dialog).toHaveCount(0);
      await expect(page.getByTestId('reopen-return'), 'the control leaves with the completion').toHaveCount(0);
      const reopenedRow = page.locator('.quote-line', { has: page.getByTestId('reopened-notice') });
      await expect(reopenedRow, 'the row says it was reopened').toBeVisible();
      await expect(reopenedRow.getByTestId('reopened-notice')).toContainText('Reopened');
      await expect(reopenedRow.getByTestId('reopened-notice')).toContainText(reason);
      await expect(reopenedRow.getByText('filed', { exact: true }).first()).toBeVisible();
      const reopened = (await read(page, `/tax-engagements/${te}`)) as { taxEngagement: Record<string, unknown>; jurisdictions_awaiting: string[] };
      expect(reopened.taxEngagement.stage).toBe('filed');
      expect(reopened.taxEngagement.reopen_reason).toBe(reason);
      expect(reopened.jurisdictions_awaiting, 'the acceptance that completed it no longer counts').toEqual(['federal']);
      steps.push(`R1|/clients/:id Returns card, completed row, button "Reopen…" (modal "Reopen this return": required Reason, button "Reopen the return") → the row reads filed with the badge "Reopened" and the reason|${ROLES}|tap`);

      // ── R2. THE ENGAGEMENT ACTIVE, THE COUNT UP ────────────────────────────────────────
      const engagementsAfter = (await read(page, `/engagements?contactId=${contactId}`)).engagements as Array<Record<string, unknown>>;
      expect(engagementsAfter.find((e) => e.service_line === 'tax')!.status, 'the engagement returns to active').toBe('active');
      expect(await filedCount(token), 'the executive view counts the return as open again').toBe(countBefore + 1);
      steps.push(`R2|GET /engagements from the session: the tax engagement reads active; GET /dashboards/executive: "Open returns by stage" filed is one higher than before the tap|${ROLES}|tap`);

      // ── R3. RE-COMPLETION REFUSED UNTIL A NEW ACCEPTANCE ────────────────────────────────
      const forced = await page.evaluate(async (id) => {
        const r = await fetch(`/api/tax-engagements/${id}/transition`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ toStage: 'completed' }) });
        return { status: r.status, body: (await r.json().catch(() => ({}))) as { error?: string; message?: string } };
      }, te);
      expect(forced.status, 'a forced completion is refused').toBe(409);
      expect(forced.body.error).toBe('jurisdictions_awaiting');
      expect(forced.body.message).toContain('since it was reopened');
      const fresh = await asStaff<{ stage: string }>(token, `/tax-engagements/${te}/efile-result`, { method: 'POST', body: JSON.stringify({ result: 'accepted' }) });
      expect(fresh.stage, 'a new acceptance completes it').toBe('completed');
      const closed = (await asStaff<{ engagements: Array<Record<string, unknown>> }>(token, `/engagements?contactId=${contactId}`)).engagements;
      expect(closed.find((e) => e.service_line === 'tax')!.status, 'and the engagement closes again').toBe('completed');
      await page.goto(clientPage);
      await expect(page.getByRole('heading', { name: 'Returns' })).toBeVisible();
      await expect(page.getByTestId('reopened-notice'), 'the notice leaves with the new completion').toHaveCount(0);
      await expect(page.getByTestId('reopen-return'), 'and the door is open again').toBeVisible();
      steps.push(`R3|POST /tax-engagements/:id/transition {completed} from the session refused 409 jurisdictions_awaiting "since it was reopened"; POST /efile-result accepted completes it; the engagement reads completed and the row offers "Reopen…" again|${ROLES}|tap`);

      await page.screenshot({ path: shot, fullPage: true });
      passed = true;
    } finally {
      if (!existsSync(shot)) await page.screenshot({ path: shot, fullPage: true }).catch(() => undefined);
      testInfo.annotations.push({ type: passed ? 'artifact' : 'failure-screenshot', description: keepScreenshot(`reopen-return-${viewport}`, passed, shot) });
      for (const s of steps) testInfo.annotations.push({ type: 'walk-step', description: s });
    }
  });

  test('role proof: the tax preparer has no Reopen control and the route refuses her 403', async ({ page }, testInfo) => {
    const viewport = testInfo.project.name;
    test.setTimeout(300_000);
    const token = await staffToken();
    const { contactId, te } = await completedReturn(token, viewport, 'wall');

    await signIn(page, fixtures.wall.anamaria);
    await page.goto(`/clients/${contactId}`);
    await expect(page.getByRole('heading', { name: 'Returns' })).toBeVisible();
    await page.waitForTimeout(800);
    await expect(page.getByTestId('reopen-return'), 'no Reopen control anywhere on her page').toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Reopen…' })).toHaveCount(0);

    const refused = await page.evaluate(async (id) => {
      const r = await fetch(`/api/tax-engagements/${id}/reopen`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: 'A role proof: this reopen must be refused for a role without the permission.' }),
      });
      return { status: r.status, body: (await r.json().catch(() => ({}))) as { message?: string } };
    }, te);
    expect(refused.status, 'the reopen door refuses a role without engagements.tax.reopen').toBe(403);
    expect(refused.body.message).toBe('This session does not hold engagements.tax.reopen.');
    const after = await asStaff<{ taxEngagement: { stage: string } }>(token, `/tax-engagements/${te}`);
    expect(after.taxEngagement.stage, 'nothing moved').toBe('completed');
    testInfo.annotations.push({ type: 'walk-step', description: `R3|role proof: tax_preparer sees no "Reopen…" control on /clients/:id, POST /tax-engagements/:id/reopen refused 403 "This session does not hold engagements.tax.reopen."|${ROLES}|tap` });
  });
});
