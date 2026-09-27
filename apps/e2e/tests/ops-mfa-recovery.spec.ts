/*
 * MFA RECOVERY CODES AND RESET MFA (Brian, 2026-09-26, R65) — at 390 × 844 and 1280 × 800.
 *
 * One staff member per viewport (the two projects run in turn against one harness database), made
 * through Add staff the way ops-edit-doors does, then walked through the four steps of path M:
 *
 *   M1  the temporary password signs them in, the enrolment screen shows the secret, then the eight
 *       recovery codes once, behind "I saved these"; the owed password is set on the Account page;
 *   M2  a recovery code in the authenticator field signs them in; the CEO has the mfa_recovery_used
 *       task and the Ops alert (read through the CEO API); the same code again is refused in the
 *       server's words;
 *   M3  the CEO presses "Reset MFA…" on the row with a reason; the row reads pending; the member's
 *       next sign-in lands on the enrolment screen;
 *   M4  the role proof: comms_billing (Rene's role) sees no Reset MFA control and the route says
 *       "This session does not hold staff.mfa.reset."
 *   M5  R71 (2026-09-27): the three staff mails this walk produced (the temporary-password notice at
 *       Add staff, the recovery-code alert to the CEO at M2, the reset notice at M3) are read from the
 *       harness mailbox; each link opens the Ops sign-in page, the notice never carries the password,
 *       and the reset mail's link signs the member in to the enrolment screen.
 *
 * Nothing here is a secret: the accounts are synthetic and the codes die with the harness database.
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
  wall: { rene: Persona };
};
const API = `http://localhost:${fixtures.port}`;
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
const CODE_SHAPE = /^[A-Z2-9]{4}-[A-Z2-9]{4}$/;
const REASON = 'Phone replaced; the old authenticator is gone.';

const M1_CONTROL = '/login Email, Password (the temporary one), "Sign in"; secret shown; "Code from your authenticator", "Enable MFA + sign in"; eight codes under data-testid recovery-codes; button "I saved these"; then /account "Change password"';
const M2_CONTROL = '/login "Authenticator code or recovery code (if enrolled)" with a recovery code, "Sign in"; the mfa_recovery_used task and the Ops alert read through GET /tasks/search and GET /notifications as the CEO; the same code again refused inline';
const M3_CONTROL = '/admin/staff row button "Reset MFA…", modal "Reset MFA for …?", reason textarea, button "Reset MFA"; the row\'s MFA badge reads pending; the member\'s /login lands on the enrolment screen';
const M4_CONTROL = '/admin/staff as comms_billing: no "Reset MFA…" button; POST /staff/:id/mfa/reset answers 403 "This session does not hold staff.mfa.reset."';
const M5_CONTROL = 'the harness mailbox (GET /harness/mail-links staffMails): "Your SAOS sign-in: a temporary password was issued", "SAOS alert: … signed in with an MFA recovery code", "Your SAOS sign-in: MFA was reset"; each "Sign in here:" link opened in the address bar → /login Email, Password, "Sign in"; the reset link signs the member in to the enrolment screen';
const ROLES = 'ceo (staff.mfa.reset, explicit-only); the member signs in as themselves';

const code = (secret: string) => new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) }).generate();

async function signIn(page: Page, who: Persona): Promise<void> {
  await page.goto('/login');
  const status = await page.evaluate(async ({ email, password, totp }) => {
    const r = await fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password, totp }) });
    sessionStorage.setItem('saos_staff_authed', '1');
    return r.status;
  }, { email: who.email, password: who.password, totp: code(who.totpSecret) });
  expect(status, `${who.email} signs in`).toBe(200);
}
/**
 * The sign-in form typed by hand. WebKit at 390 filled the Email before React hydrated and the
 * hydration reset it, so each field is filled after the page settles and read back before Sign in.
 */
async function typeSignIn(page: Page, email: string, password: string, secondFactor?: string): Promise<void> {
  await page.goto('/login');
  await page.waitForLoadState('networkidle');
  const emailBox = page.getByLabel('Email');
  const passwordBox = page.getByLabel('Password', { exact: true });
  const codeBox = page.getByLabel(/^Authenticator code or recovery code/);
  await emailBox.fill(email);
  await passwordBox.fill(password);
  if (secondFactor) await codeBox.fill(secondFactor);
  await expect(emailBox).toHaveValue(email);
  await expect(passwordBox).toHaveValue(password);
  if (secondFactor) await expect(codeBox).toHaveValue(secondFactor);
  await page.getByRole('button', { name: 'Sign in' }).click();
}
/** The inline refusal under the form: the page's own words, never Next's empty route announcer. */
const fieldError = (page: Page) => page.locator('p.field-error[role=alert]');
async function signOut(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
    sessionStorage.removeItem('saos_staff_authed');
  });
}
async function ceoToken(): Promise<string> {
  const { email, password, totpSecret } = fixtures.staff;
  const r = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password, totp: code(totpSecret) }) });
  expect(r.status, 'the CEO signs in through the API').toBe(200);
  return ((await r.json()) as { token: string }).token;
}
function keepScreenshot(name: string, passed: boolean, file: string): string {
  const dir = passed ? resolve(here, '..', '.artifacts', today) : resolve(root, 'tasks', 'walks', today);
  mkdirSync(dir, { recursive: true });
  const target = resolve(dir, `${name}.png`);
  if (existsSync(file)) copyFileSync(file, target);
  return target;
}

test.describe('Ops → MFA recovery codes and Reset MFA (R65)', () => {
  test('M1–M5: enrolment shows the codes once, a code signs in once and alerts the CEO, the CEO resets MFA with a reason, comms_billing is refused, each staff mail links to the Ops sign-in page', async ({ page }, testInfo) => {
    test.setTimeout(300_000);
    const viewport = testInfo.project.name;
    const cap = viewport.charAt(0).toUpperCase() + viewport.slice(1);
    const legalName = `Synthetic Recover-${cap}`;
    const displayName = `Rec ${cap}`;
    const email = `recover-${viewport}@example.test`;
    const ownPassword = `recover-${viewport}-own-password-2026`;
    const shots: Record<string, string> = {};
    const shot = (step: string) => (shots[step] = testInfo.outputPath(`mfa-${step}-${viewport}.png`));
    const cleared = new Set<string>();
    let memberId = '';
    try {
      // ── The account, made by the CEO through Add staff; the temporary password read once from the reveal.
      await signIn(page, fixtures.staff);
      await page.goto('/admin/staff');
      const add = page.locator('section.card', { has: page.getByRole('heading', { name: 'Add staff' }) });
      await expect(add).toBeVisible();
      await add.getByLabel(/^Legal name/).fill(legalName);
      await add.getByLabel(/^Display name/).fill(displayName);
      await add.getByLabel(/^Email/).fill(email);
      await add.getByLabel(/^Role/).selectOption('bookkeeper');
      await add.getByRole('button', { name: 'Create account' }).click();
      const reveal = page.getByTestId('temp-password-reveal');
      await expect(reveal).toBeVisible();
      const tempPassword = (await reveal.locator('code').textContent())?.trim() ?? '';
      expect(tempPassword.length, 'a temporary password was minted').toBeGreaterThan(10);
      await reveal.getByRole('button', { name: 'I have handed it over' }).click();
      await expect(reveal).toHaveCount(0);
      memberId = await page.evaluate(async (e) => {
        const r = await fetch('/api/staff');
        const j = (await r.json()) as { staff: Array<{ id: string; email: string }> };
        return j.staff.find((s) => s.email === e)?.id ?? '';
      }, email);
      expect(memberId, 'the member is on the roster').not.toBe('');
      await signOut(page);

      // ── M1: the temporary password, the enrolment screen, the eight codes shown once, "I saved these".
      await typeSignIn(page, email, tempPassword);
      const secretEl = page.getByTestId('totp-secret');
      await expect(secretEl, 'a first sign-in enrols MFA').toBeVisible();
      const secret = (await secretEl.textContent())?.trim() ?? '';
      await page.getByTestId('enroll-code').fill(code(secret));
      await page.getByRole('button', { name: 'Enable MFA + sign in' }).click();
      const panel = page.getByTestId('recovery-codes-panel');
      await expect(panel).toBeVisible();
      const codes = (await page.getByTestId('recovery-codes').locator('li').allTextContents()).map((c) => c.trim());
      expect(codes.length, 'eight recovery codes').toBe(8);
      for (const c of codes) expect(c, `code shape ${c}`).toMatch(CODE_SHAPE);
      expect(new Set(codes).size, 'all distinct').toBe(8);
      const saved = panel.getByRole('button', { name: 'I saved these' });
      await expect(saved, 'the session waits for the press').toBeVisible();
      expect(page.url(), 'still on the sign-in page until the codes are saved').toContain('/login');
      await page.screenshot({ path: shot('M1'), fullPage: true });
      await saved.click();
      await page.waitForURL(/\/account\?set-password=1/);
      // The owed password, set on the Account page, so the member has a credential of their own.
      await page.getByLabel('Current password').fill(tempPassword);
      await page.getByLabel(/^New password/).fill(ownPassword);
      await page.getByLabel('Confirm new password').fill(ownPassword);
      await page.getByRole('button', { name: 'Change password' }).click();
      await expect(page.getByText(/^Password changed\./)).toBeVisible();
      cleared.add('M1');
      await signOut(page);

      // ── M2: a recovery code in the authenticator field signs in once; the CEO is told; the same code is refused.
      await typeSignIn(page, email, ownPassword, codes[0]!);
      await page.waitForURL((u) => !u.pathname.startsWith('/login'));
      await expect(page.getByTestId('sign-out'), 'a real session').toBeVisible();
      const token = await ceoToken();
      const headers = { authorization: `Bearer ${token}` };
      let task: { id: string; title: string } | undefined;
      await expect.poll(async () => {
        const r = await fetch(`${API}/tasks/search?sourceType=mfa_recovery_used`, { headers });
        const { tasks } = (await r.json()) as { tasks: Array<{ id: string; title: string }> };
        task = tasks.find((t) => t.title === `${displayName} signed in with an MFA recovery code`);
        return task ? 1 : 0;
      }, { message: 'the mfa_recovery_used task for the member exists', timeout: 15_000 }).toBe(1);
      const alerts = await fetch(`${API}/notifications`, { headers });
      const { notifications } = (await alerts.json()) as { notifications: Array<{ type: string; related_object_id: string | null; title: string }> };
      const alert = notifications.find((n) => n.type === 'mfa_recovery_used' && n.related_object_id === task!.id);
      expect(alert, 'the Ops alert points at the task').toBeTruthy();
      expect(alert!.title).toContain(displayName);
      for (const c of codes) expect(alert!.title + task!.title, 'no code in the alert or the task').not.toContain(c);
      await signOut(page);
      await typeSignIn(page, email, ownPassword, codes[0]!);
      await expect(fieldError(page), 'the used code is refused in the server\'s words').toHaveText('The email, password or code did not match.');
      expect(page.url()).toContain('/login');
      await page.screenshot({ path: shot('M2'), fullPage: true });
      cleared.add('M2');

      // ── M3: the CEO's Reset MFA with a reason, the row reads pending, the member's next sign-in enrols again.
      await signIn(page, fixtures.staff);
      await page.goto('/admin/staff');
      const team = page.locator('section.card', { has: page.getByRole('heading', { name: 'Team' }) });
      const row = team.locator('tr', { hasText: email });
      await expect(row).toBeVisible();
      await expect(row.locator('.badge', { hasText: /^on$/ }), 'MFA is on before the reset').toBeVisible();
      await row.getByRole('button', { name: 'Reset MFA…' }).click();
      const modal = page.locator('[role=dialog]', { hasText: `Reset MFA for ${displayName}?` });
      await expect(modal).toBeVisible();
      const go = modal.getByRole('button', { name: 'Reset MFA', exact: true });
      await expect(go, 'the reason is required before the press').toBeDisabled();
      await modal.locator('textarea').fill(REASON);
      await go.click();
      await expect(modal).toHaveCount(0);
      await expect(page.getByText(`${displayName}: MFA reset (audited). They were emailed; their next sign-in enrols a new authenticator.`)).toBeVisible();
      await expect(team.locator('tr', { hasText: email }).locator('.badge', { hasText: /^pending$/ }), 'the row reads pending').toBeVisible();
      await page.screenshot({ path: shot('M3'), fullPage: true });
      await signOut(page);
      await typeSignIn(page, email, ownPassword);
      await expect(page.getByTestId('totp-secret'), 'the next sign-in lands on enrolment').toBeVisible();
      await expect(page.getByText(/MFA is required for all staff accounts/)).toBeVisible();
      cleared.add('M3');

      // ── M4: the role proof. comms_billing sees no control and the route refuses in the server's words.
      await signIn(page, fixtures.wall.rene);
      await page.goto('/admin/staff');
      await expect(page.getByRole('heading', { name: 'Staff & permissions' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Reset MFA…' })).toHaveCount(0);
      const refused = await page.evaluate(async ({ id, reason }) => {
        const r = await fetch(`/api/staff/${id}/mfa/reset`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason }) });
        return { status: r.status, body: (await r.json()) as { error?: string; permission?: string; message?: string } };
      }, { id: memberId, reason: REASON });
      expect(refused.status).toBe(403);
      expect(refused.body.error).toBe('forbidden');
      expect(refused.body.permission).toBe('staff.mfa.reset');
      expect(refused.body.message).toBe('This session does not hold staff.mfa.reset.');
      await page.screenshot({ path: shot('M4'), fullPage: true });
      cleared.add('M4');

      // ── M5 (R71): each staff mail's link, read from the harness mailbox, opens the Ops sign-in page.
      await signOut(page);
      const box = (await (await fetch(`${API}/harness/mail-links`)).json()) as {
        staffMails: Array<{ to: string; subject: string; text: string; opsLinks: string[] }>;
      };
      const one = (subject: string, to?: string) => {
        const hits = box.staffMails.filter((m) => m.subject === subject && (to === undefined || m.to === to));
        expect(hits.length, `one mail "${subject}"`).toBe(1);
        expect(hits[0]!.opsLinks.length, `"${subject}" carries one sign-in link`).toBe(1);
        return hits[0]!;
      };
      const notice = one('Your SAOS sign-in: a temporary password was issued', email);
      expect(notice.text, 'the notice never carries the password').not.toContain(tempPassword);
      const alertMail = one(`SAOS alert: ${displayName} signed in with an MFA recovery code`);
      for (const c of codes) expect(alertMail.text, 'no code in the alert mail').not.toContain(c);
      const resetMail = one('Your SAOS sign-in: MFA was reset', email);
      for (const m of [notice, alertMail, resetMail]) {
        const link = m.opsLinks[0]!;
        expect(new URL(link).pathname, `${m.subject}: the Ops sign-in page`).toBe('/login');
        await page.goto(link);
        await page.waitForLoadState('networkidle');
        await expect(page.getByLabel('Email'), `${m.subject}: the sign-in form`).toBeVisible();
        await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
      }
      // The reset mail's page is a working sign-in: the member lands on enrolment, as M3 said they would.
      await page.goto(resetMail.opsLinks[0]!);
      await page.waitForLoadState('networkidle');
      await page.getByLabel('Email').fill(email);
      await page.getByLabel('Password', { exact: true }).fill(ownPassword);
      await expect(page.getByLabel('Email')).toHaveValue(email);
      await page.getByRole('button', { name: 'Sign in' }).click();
      await expect(page.getByTestId('totp-secret'), 'the link signs the member in to enrolment').toBeVisible();
      await page.screenshot({ path: shot('M5'), fullPage: true });
      cleared.add('M5');
    } finally {
      for (const step of ['M1', 'M2', 'M3', 'M4', 'M5']) {
        const file = shots[step] ?? testInfo.outputPath(`mfa-${step}-${viewport}.png`);
        // A step that never reached its own screenshot keeps the screen as it was when the walk stopped.
        if (!shots[step] && !existsSync(file)) await page.screenshot({ path: file, fullPage: true }).catch(() => undefined);
        testInfo.annotations.push({ type: 'screenshot', description: keepScreenshot(`mfa-${step}-${viewport}`, cleared.has(step), file) });
      }
      const controls: Record<string, string> = { M1: M1_CONTROL, M2: M2_CONTROL, M3: M3_CONTROL, M4: M4_CONTROL, M5: M5_CONTROL };
      for (const step of cleared) testInfo.annotations.push({ type: 'walk-step', description: `${step}|${controls[step]}|${step === 'M4' ? 'role proof: comms_billing sees no control, POST refused 403' : ROLES}|tap` });
    }
  });
});
