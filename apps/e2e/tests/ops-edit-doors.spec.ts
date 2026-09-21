/*
 * EDIT AFTER CREATE, THE OTHER TWO DOORS (Brian, 2026-09-20) — at 390 × 844 and 1280 × 800.
 *
 * Every entity Ops creates is edited from Ops too, or says in writing why not (scripts/edit-doors.json).
 * Contact and business are tapped in ops-add-client and ops-add-business; this spec taps the two
 * rows the table still read "no" on:
 *
 *   task          /tasks "Create Task" with the subject alone, then the task opened from the list and
 *                 its description filled in through the same form's Save;
 *   staff member  /admin/staff "Create account" with the legal name, email and a role (the display
 *                 name skipped), the temporary password handed over, then the row's Edit door fills
 *                 the display name in.
 *
 * Both are the CEO ('*': tasks.manage, staff.manage). A distinct subject per viewport: the two
 * projects run sequentially against one harness database. Each tap pushes an edit-door annotation
 * that scripts/edit-doors.mjs reads into tasks/reports/2026-09-20-edit-doors.md.
 */
import { expect, test, type Page } from '@playwright/test';
import * as OTPAuth from 'otpauth';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..');
interface Persona { email: string; password: string; totpSecret: string }
const fixtures = JSON.parse(readFileSync(resolve(here, '..', '.artifacts', 'fixtures.json'), 'utf8')) as { staff: Persona };
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
const TASK_CONTROL = '/tasks button "Create Task", form#task-form (Subject), button "Save"; then the task opened from the list, Description filled, button "Save"';
const TASK_ROLES = 'ceo, tax_preparer, comms_billing, va_entity, bookkeeper, ed_coo (tasks.manage)';
const STAFF_CONTROL = '/admin/staff "Add staff" (Legal name, Email, Role), button "Create account", "I have handed it over"; then the row\'s button "Edit", input "Display name", button "Save"';
const STAFF_ROLES = 'ceo (staff.manage)';

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

test.describe('Ops → edit after create: task and staff member', () => {
  test('a task is created with its subject alone, then opened and given a description', async ({ page }, testInfo) => {
    const viewport = testInfo.project.name;
    const shot = testInfo.outputPath(`edit-task-${viewport}.png`);
    const title = `HARNESS-EDIT-TASK-${viewport.toUpperCase()}`;
    const description = `Filled in after creation on the ${viewport} walk.`;
    let passed = false;
    try {
      await signIn(page, fixtures.staff);
      await page.goto('/tasks');
      await expect(page.getByRole('heading', { name: 'Tasks' })).toBeVisible();
      await page.getByRole('button', { name: 'Create Task' }).click();
      const form = page.locator('[role=dialog]', { has: page.getByRole('heading', { name: 'Create Task' }) });
      await expect(form).toBeVisible();
      await form.getByLabel(/^Subject/).fill(title);
      await form.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(form).toHaveCount(0);
      const row = page.getByText(title, { exact: true }).first();
      await expect(row, 'the task is in the list').toBeVisible();

      // ── EDIT: the same form, opened on the record, the description filled in.
      await row.click();
      const edit = page.locator('[role=dialog]', { has: page.getByRole('heading', { name: 'Edit Task' }) });
      await expect(edit).toBeVisible();
      await expect(edit.getByLabel(/^Subject/), 'the form opens on the record').toHaveValue(title);
      await edit.getByLabel(/^Description/).fill(description);
      await edit.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(edit).toHaveCount(0);
      // Proven from the record, not the screen: the list does not print descriptions.
      const saved = await page.evaluate(async (t) => {
        const r = await fetch(`/api/tasks/search?q=${encodeURIComponent(t)}`);
        const j = (await r.json()) as { tasks?: Array<{ title: string; description: string | null }> };
        return j.tasks?.find((x) => x.title === t)?.description ?? null;
      }, title);
      expect(saved, 'the description is on the task').toBe(description);
      await page.screenshot({ path: shot, fullPage: true });
      passed = true;
    } finally {
      if (!existsSync(shot)) await page.screenshot({ path: shot, fullPage: true }).catch(() => undefined);
      testInfo.annotations.push({ type: 'screenshot', description: keepScreenshot(`edit-task-${viewport}`, passed, shot) });
      testInfo.annotations.push({ type: 'edit-door', description: `task|${TASK_CONTROL}|${TASK_ROLES}|tap` });
    }
  });

  test('a staff member is created without a display name, the password handed over, then the row edited to add one', async ({ page }, testInfo) => {
    const viewport = testInfo.project.name;
    const shot = testInfo.outputPath(`edit-staff-${viewport}.png`);
    const legalName = `Synthetic Editstaff-${viewport.charAt(0).toUpperCase()}${viewport.slice(1)}`;
    const email = `editstaff-${viewport}@example.test`;
    const displayName = `Ed ${viewport}`;
    let passed = false;
    try {
      await signIn(page, fixtures.staff);
      await page.goto('/admin/staff');
      const add = page.locator('section.card', { has: page.getByRole('heading', { name: 'Add staff' }) });
      await expect(add).toBeVisible();
      await add.getByLabel(/^Legal name/).fill(legalName);
      await add.getByLabel(/^Email/).fill(email);
      await add.getByLabel(/^Role/).selectOption('bookkeeper');
      await add.getByRole('button', { name: 'Create account' }).click();
      // The temporary password is shown once, to the person who minted it, and never read here.
      const reveal = page.getByTestId('temp-password-reveal');
      await expect(reveal).toBeVisible();
      await reveal.getByRole('button', { name: 'I have handed it over' }).click();
      await expect(reveal).toHaveCount(0);
      const team = page.locator('section.card', { has: page.getByRole('heading', { name: 'Team' }) });
      const row = team.locator('tr', { hasText: email });
      await expect(row, 'the new account is on the team list').toBeVisible();

      // ── EDIT: the row's door, the display name filled in.
      await row.getByRole('button', { name: 'Edit' }).click();
      // In edit mode the row's name and email are input values, not text, so the row is found by its
      // open editor (one row edits at a time) rather than by the email it no longer prints.
      const editing = team.locator('tr', { has: page.getByLabel('Sign-in email') });
      await expect(editing.getByLabel('Sign-in email'), 'the editor opens on the record').toHaveValue(email);
      await editing.getByLabel('Display name').fill(displayName);
      await editing.getByRole('button', { name: 'Save' }).click();
      await expect(page.getByText(/name updated \(audited/), 'the page says what changed').toBeVisible();
      await expect(team.locator('tr', { hasText: email }), 'the display name is on the row').toContainText(displayName);
      await page.screenshot({ path: shot, fullPage: true });
      passed = true;
    } finally {
      if (!existsSync(shot)) await page.screenshot({ path: shot, fullPage: true }).catch(() => undefined);
      testInfo.annotations.push({ type: 'screenshot', description: keepScreenshot(`edit-staff-${viewport}`, passed, shot) });
      testInfo.annotations.push({ type: 'edit-door', description: `staff member|${STAFF_CONTROL}|${STAFF_ROLES}|tap` });
    }
  });
});
