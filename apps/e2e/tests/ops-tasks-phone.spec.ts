/*
 * PAGE THREE: Ops → Tasks, at 390 × 844 and 1280 × 800 (Brian's rulings 5a–5h, 2026-09-10,
 * unlocked by five consecutive green runs of pages one and two).
 *
 * This page is where the phone walk spent most of its findings: Kanban and Timeline offered at
 * a width neither survives, a checkbox on every card so a missed tap entered bulk mode, eleven
 * controls on a 390px card, a mass-complete that fired without saying how many, an input in the
 * bulk bar with no label, and six hundred migration rows sitting in the row a person uses to work.
 *
 * Every assertion below is one of those, and they run against the PRODUCTION build.
 */
import { expect, test, type Page } from '@playwright/test';
import * as OTPAuth from 'otpauth';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..');
const fixtures = JSON.parse(readFileSync(resolve(here, '..', '.artifacts', 'fixtures.json'), 'utf8')) as {
  staff: { email: string; password: string; totpSecret: string }; opsPort: number;
};
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());

test.use({ baseURL: `http://localhost:${fixtures.opsPort ?? 3105}` });

async function signIn(page: Page): Promise<void> {
  const code = new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(fixtures.staff.totpSecret) }).generate();
  await page.goto('/login');
  const status = await page.evaluate(async ({ email, password, totp }) => {
    const r = await fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password, totp }) });
    sessionStorage.setItem('saos_staff_authed', '1');
    return r.status;
  }, { email: fixtures.staff.email, password: fixtures.staff.password, totp: code });
  expect(status, 'the staff login').toBe(200);
}

function keepScreenshot(name: string, passed: boolean, file: string): string {
  const dir = passed ? resolve(here, '..', '.artifacts', today) : resolve(root, 'tasks', 'walks', today);
  mkdirSync(dir, { recursive: true });
  const target = resolve(dir, `${name}.png`);
  if (existsSync(file)) copyFileSync(file, target);
  return target;
}

test.describe('Ops → Tasks', () => {
  test('is a queue a person can work at this viewport', async ({ page }, testInfo) => {
    const viewport = testInfo.project.name; // phone | desk
    const phone = viewport === 'phone';
    const shot = testInfo.outputPath(`tasks-${viewport}.png`);
    let passed = false;
    try {
      await signIn(page);
      await page.goto('/tasks');
      await expect(page.getByRole('heading', { name: 'Tasks' })).toBeVisible();
      await page.waitForTimeout(1500);

      // 5a. Kanban and Timeline are not offered at a width neither survives.
      const views = (await page.locator('.viewtabs button').allTextContents()).map((t) => t.trim());
      if (phone) {
        expect(views, 'the phone is offered only the views that work on it').toEqual(['List', 'Calendar']);
      } else {
        expect(views, 'the desk keeps all four').toEqual(['List', 'Kanban', 'Calendar', 'Timeline']);
      }

      // Nothing overflows, at either width.
      const widths = await page.evaluate(() => ({ vw: document.documentElement.clientWidth, sw: document.documentElement.scrollWidth }));
      expect(widths.sw, 'the page fits its viewport').toBe(widths.vw);

      // 5g. The migration backlog is not one of the working-view chips.
      const chipRow = await page.locator('.chipbar').innerText().catch(() => '');
      expect(chipRow, 'the backlog is not in the row a person works from').not.toContain('Migration backlog');
      await expect(page.getByRole('button', { name: /Migration backlog/ }), 'but it is still reachable').toHaveCount(1);

      if (phone) {
        // 5e. No checkbox until select mode is turned on by name.
        expect(await page.locator('.tcard input[type=checkbox]').count(), 'no checkboxes before Select').toBe(0);

        // 5c. The face carries one action.
        const firstCard = page.locator('.tcard').first();
        if (await firstCard.count()) {
          await expect(firstCard.getByRole('button', { name: 'Complete' }), 'one action on the face').toHaveCount(1);
          expect(await firstCard.locator('.tctl select').count(), 'no dropdowns on the face').toBe(0);

          // 5d. Status, priority and owner are one tap in, and they are real controls.
          await firstCard.getByRole('button', { name: 'More' }).click();
          await expect(firstCard.locator('.tmore')).toBeVisible();
          // A label's text content swallows the option list of the select inside it, so the
          // name is the label's first text node, not everything under it.
          const labels = await firstCard.locator('.tmore label').evaluateAll((els) =>
            els.map((el) => (el.childNodes[0]?.textContent ?? '').trim())
          );
          expect(labels, 'status, priority and owner behind the expand').toEqual(['Status', 'Priority', 'Owner']);
          await firstCard.getByRole('button', { name: 'Less' }).click();
          await expect(firstCard.locator('.tmore')).toHaveCount(0);
        }

        // 5e again: Select is a toggle, and it is what brings the checkboxes.
        await page.getByRole('button', { name: 'Select', exact: true }).click();
        const boxes = await page.locator('.tcard input[type=checkbox]').count();
        expect(boxes, 'select mode shows the checkboxes').toBeGreaterThan(0);

        if (boxes > 0) {
          // 5f. Mass complete says how many before it does anything.
          await page.locator('.tcard input[type=checkbox]').first().check();
          await page.getByRole('button', { name: 'Mass complete' }).click();
          const modal = page.locator('[role=dialog]');
          await expect(modal).toBeVisible();
          await expect(modal.getByRole('heading', { name: /^Complete 1 task\?$/ }), 'the count is named').toBeVisible();
          await modal.getByRole('button', { name: 'Cancel' }).click();
          await expect(modal).toHaveCount(0);

          // 5h. Nothing in the bulk bar is an unlabelled input.
          const unlabelled = await page.evaluate(() => {
            const bar = document.querySelector('.bulkbar') ?? document.querySelector('.bulk-bar');
            if (!bar) return 0;
            return [...bar.querySelectorAll('input, select')].filter((el) => {
              const id = el.getAttribute('id');
              return !el.getAttribute('aria-label')
                && !el.closest('label')
                && !(id && document.querySelector(`label[for="${id}"]`));
            }).length;
          });
          expect(unlabelled, 'every control in the bulk bar says what it is').toBe(0);
        }

        await page.getByRole('button', { name: 'Done selecting' }).click();
        expect(await page.locator('.tcard input[type=checkbox]').count(), 'and select mode turns off').toBe(0);
      }
      passed = true;
    } finally {
      await page.screenshot({ path: shot, fullPage: true });
      const kept = keepScreenshot(`tasks-${viewport}`, passed, shot);
      testInfo.annotations.push({ type: passed ? 'artifact' : 'failure-screenshot', description: kept });
    }
  });
});
