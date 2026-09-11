/*
 * PAGE ONE: Ops → client page, at 390 × 844 and 1280 × 800 (decision 3, 2026-09-10).
 *
 * Each assertion is a walk failure that happened. A failing run writes its screenshot to
 * tasks/walks/<date>/ (committed, so the morning report links what the machine saw); a passing
 * run keeps its screenshot under .artifacts/<date>/ (local, 14 days).
 */
import { expect, test, type Page } from '@playwright/test';
import * as OTPAuth from 'otpauth';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..');
const fixtures = JSON.parse(readFileSync(resolve(here, '..', '.artifacts', 'fixtures.json'), 'utf8')) as {
  contactId: string; staff: { email: string; password: string; totpSecret: string };
};
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
const ISO_T = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
// A badge reading one of these is the raw enum, not the label map's word (Ops lib/labels.ts).
const ENUM_KEYS = new Set(['draft', 'sent', 'paid', 'overdue', 'void', 'refunded', 'partially_refunded', 'disputed', 'active', 'on_hold', 'completed', 'withdrawn', 'accepted', 'declined', 'expired', 'not_on_file', 'requested', 'signed', 'revoked', 'pending']);
const RAW_ENUM = (b: string) => ENUM_KEYS.has(b) || /^[a-z]+(?:_[a-z]+)+$/.test(b);

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

test.describe('Ops → client page', () => {
  test('reads the way a person would, at this viewport', async ({ page }, testInfo) => {
    const viewport = testInfo.project.name; // phone | desk
    const shot = testInfo.outputPath(`client-page-${viewport}.png`);
    let passed = false;
    try {
      await signIn(page);
      await page.goto(`/clients/${fixtures.contactId}`);
      await expect(page.getByRole('heading', { name: /Invoices \(/ })).toBeVisible();
      // Let the send logs and notices settle.
      await page.waitForTimeout(1500);

      // 1. No text on the page is a raw ISO timestamp.
      const text = await page.evaluate(() => document.body.innerText);
      expect(text, 'no ISO-T leak').not.toMatch(ISO_T);
      // 2. No ⚠ marker: no instant was handed to the calendar-day formatter.
      expect(text, 'no wrong-helper marker').not.toContain('⚠');
      // 3. Every engagement row's dates read in order.
      const pairs = await page.evaluate(() => [...document.querySelectorAll('.quote-line .muted.small')]
        .map((s) => s.textContent ?? '')
        .filter((t) => /started .* · ended /.test(t))
        .map((t) => { const m = /started (.+?) · ended (.+?)(?: ·|$)/.exec(t); return m ? [m[1], m[2]] : null; })
        .filter(Boolean) as string[][]);
      for (const [started, ended] of pairs) {
        expect(new Date(started).getTime(), `${started} ≤ ${ended}`).toBeLessThanOrEqual(new Date(ended).getTime());
      }
      // 4. Nothing overflows the viewport.
      const widths = await page.evaluate(() => ({ vw: document.documentElement.clientWidth, sw: document.documentElement.scrollWidth }));
      expect(widths.sw, 'document scroll width equals the viewport').toBe(widths.vw);
      // 5. The void row: badge, then reason · actor · date, then sent date — stacked on the phone,
      //    one line on the desk; the actor is a name with no "@".
      const voidMeta = await page.evaluate(() => {
        const rows = [...document.querySelectorAll('.invoice-meta')];
        const withVoid = rows.find((r) => /void ·|Cancelled/.test(r.parentElement?.textContent ?? ''));
        if (!withVoid) return null;
        const spans = [...withVoid.querySelectorAll(':scope > span')].map((s) => ({ text: (s.textContent ?? '').trim(), top: Math.round(s.getBoundingClientRect().top), display: getComputedStyle(s).display }));
        return spans;
      });
      expect(voidMeta, 'a cancelled invoice is on the page').not.toBeNull();
      const voidLine = voidMeta!.find((s) => /^void · /.test(s.text))!;
      expect(voidLine, 'the void line exists').toBeTruthy();
      expect(voidLine.text, 'the actor is a name').not.toMatch(/@/);
      if (voidMeta!.length > 1) {
        const tops = new Set(voidMeta!.map((s) => s.top));
        if (viewport === 'phone') expect(tops.size, 'stacked on the phone').toBe(voidMeta!.length);
        else expect(tops.size, 'one line on the desk').toBe(1);
      }
      // 6. Badges read words, never the raw enum.
      const badges = await page.evaluate(() => [...document.querySelectorAll('.badge')].map((b) => (b.textContent ?? '').trim()));
      const rawEnum = badges.filter(RAW_ENUM);
      expect(rawEnum, 'no raw enum on a badge').toEqual([]);
      // 7. The send log opens, and every row wraps inside the viewport.
      // Real taps here too, one summary at a time, for the same reason as step 8.
      const logs = page.locator('details summary', { hasText: /send log/i });
      for (let i = 0; i < (await logs.count()); i++) await logs.nth(i).click();
      await page.waitForTimeout(800);
      const overflowing = await page.evaluate(() => [...document.querySelectorAll('.send-log li')].filter((li) => li.getBoundingClientRect().right > document.documentElement.clientWidth + 1).length);
      expect(overflowing, 'send-log rows inside the viewport').toBe(0);
      /*
       * 8. Withdraw on the engagement that holds a paid deposit: the in-app modal, the reason,
       *    then the refund-or-transfer choice, and Cancel leaves it active.
       *
       * THE TAP IS A REAL TAP (2026-09-10). This step used to reach into the DOM and call
       * .click() on the button it found. That dispatches the event straight at the element and
       * skips every question a finger has to answer: is the control scrolled into view, is it
       * covered by something, does it still sit where it was measured. So the harness could
       * drive a button a person cannot reach — which is exactly the shape of the failure Brian
       * hit on his phone while this page was green five runs out of five. Playwright's own click
       * hit-tests: it scrolls the control into view, waits for it to be stable, and FAILS if
       * another element would receive the tap.
       */
      const depositRow = page.locator('.quote-line')
        .filter({ hasNot: page.getByText('Books, monthly') })
        .filter({ has: page.getByRole('button', { name: 'Withdraw' }) })
        .first();
      await expect(depositRow, 'a Withdraw control on the deposit engagement').toBeVisible();
      await depositRow.getByRole('button', { name: 'Withdraw' }).click();

      const modal = page.locator('[role=dialog]');
      await expect(modal).toBeVisible();
      await expect(modal.getByRole('heading', { name: 'Withdraw this engagement?' })).toBeVisible();
      await expect(modal.getByRole('button', { name: 'Withdraw' })).toBeDisabled();
      await modal.locator('textarea').fill('harness walk: duplicate engagement');
      await modal.getByRole('button', { name: 'Withdraw' }).click();
      await expect(modal.getByRole('heading', { name: 'This engagement holds a paid deposit' })).toBeVisible();
      await expect(modal.getByRole('button', { name: 'Move to Books, monthly' })).toBeVisible();
      await expect(modal.getByRole('button', { name: 'Raise the refund' })).toBeVisible();
      await modal.getByRole('button', { name: 'Cancel' }).click();
      await expect(modal).toHaveCount(0);
      await expect(depositRow.locator('.badge').first(), 'the engagement is still active after Cancel').toHaveText('Active');

      passed = true;
    } finally {
      await page.screenshot({ path: shot, fullPage: true });
      const kept = keepScreenshot(`client-page-${viewport}`, passed, shot);
      testInfo.annotations.push({ type: passed ? 'artifact' : 'failure-screenshot', description: kept });
    }
  });
});
