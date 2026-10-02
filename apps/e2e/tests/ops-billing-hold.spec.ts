/*
 * THE BILLING HOLD ON AN IMPORTED ENGAGEMENT (Brian, 2026-09-26, R68) — at 390 × 844 and 1280 × 800.
 *
 * One held client per viewport (the two projects run in turn against one harness database), whose
 * sales-tax engagement the Trello importer's own function made at boot. Path L:
 *
 *   L1  the CEO reads the row: the badge "Billing on hold (imported)" carrying the importer's reason,
 *       the status sentence "Active · billing on hold (imported)", and the "Lift billing hold…" control;
 *   L2  the CEO lifts it with a reason: a chat-artifact reason is refused under the field in the
 *       server's words; the real reason lands; the confirmation reads; the badge is gone because the
 *       row came back without the hold;
 *   L3  the role proof: ed_coo (engagements.read) reads the badge and has no control; comms_billing
 *       (Rene's role) has no control and the route answers 403 "This session does not hold
 *       engagements.billing_hold.lift."
 *
 * Synthetic data only; the accounts and the hold die with the harness database.
 */
import { expect, test, type Page } from '@playwright/test';
import { opsSignOut } from './ops-sign-out';
import * as OTPAuth from 'otpauth';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { viewportKey } from './viewport';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..');
interface Persona { email: string; password: string; totpSecret: string }
interface Held { contactId: string; engagementId: string; holdReason: string }
const fixtures = JSON.parse(readFileSync(resolve(here, '..', process.env.E2E_ARTIFACTS ?? '.artifacts', 'fixtures.json'), 'utf8')) as {
  staff: Persona;
  billingHold: { phone: Held; desk: Held };
  wall: { jaqueline: Persona; rene: Persona };
};
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
const REASON = 'Old-system billing reconciled with the client; SAOS bills from October.';
const ARTIFACT = 'Lifting it as discussed on the call';

const L1_CONTROL = '/clients/:id Engagements row: badge "Billing on hold (imported)" (title = the importer\'s reason), status badge "Active · billing on hold (imported)", button "Lift billing hold…"';
const L2_CONTROL = 'button "Lift billing hold…", modal "Lift the billing hold?", reason textarea (a chat-artifact reason refused under the field in the server\'s words), button "Lift billing hold"; the confirmation sentence; the badge gone from the re-read row';
const L3_CONTROL = 'as ed_coo: the badge with no "Lift billing hold…" button; as comms_billing: no button, POST /engagements/:id/billing-hold/lift answers 403 "This session does not hold engagements.billing_hold.lift."';
const ROLES = 'ceo (engagements.billing_hold.lift, explicit-only)';

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
async function signOut(page: Page): Promise<void> {
  await opsSignOut(page);
}
function keepScreenshot(name: string, passed: boolean, file: string): string {
  const dir = passed ? resolve(here, '..', '.artifacts', today) : resolve(root, 'tasks', 'walks', today);
  mkdirSync(dir, { recursive: true });
  const target = resolve(dir, `${name}.png`);
  if (existsSync(file)) copyFileSync(file, target);
  return target;
}

test.describe('Ops → the billing hold on an imported engagement (R68)', () => {
  test('L1–L3: the hold shown, ed_coo and comms_billing refused, the CEO lifts it with a reason', async ({ page }, testInfo) => {
    test.setTimeout(240_000);
    const viewport = viewportKey(testInfo);
    const held = fixtures.billingHold[viewport];
    const url = `/clients/${held.contactId}`;
    const shots: Record<string, string> = {};
    const shot = (step: string) => (shots[step] = testInfo.outputPath(`billing-hold-${step}-${viewport}.png`));
    const cleared = new Set<string>();
    const heldRow = () => page.locator('.quote-line', { has: page.getByTestId('engagement-billing-hold') });
    try {
      // ── L1: the CEO reads the hold on the row.
      await signIn(page, fixtures.staff);
      await page.goto(url);
      await expect(page.getByRole('heading', { name: 'Engagements' })).toBeVisible();
      const row = heldRow();
      await expect(row, 'one held engagement on this client').toHaveCount(1);
      const badge = row.getByTestId('engagement-billing-hold');
      await expect(badge).toHaveText('Billing on hold (imported)');
      await expect(badge, 'the badge carries the importer\'s own reason').toHaveAttribute('title', held.holdReason);
      expect(held.holdReason).toBe('Imported from Trello; billing starts when the CEO lifts the hold.');
      await expect(row.getByTestId('engagement-status'), 'the status sentence says it').toHaveText('Active · billing on hold (imported)');
      const lift = row.getByRole('button', { name: 'Lift billing hold…' });
      await expect(lift).toBeVisible();
      await page.screenshot({ path: shot('L1'), fullPage: true });
      cleared.add('L1');
      await signOut(page);

      // ── L3: the role proof. ed_coo reads the badge and gets no control; comms_billing gets no control and 403.
      await signIn(page, fixtures.wall.jaqueline);
      await page.goto(url);
      await expect(page.getByRole('heading', { name: 'Engagements' })).toBeVisible();
      await expect(heldRow().getByTestId('engagement-billing-hold'), 'ed_coo reads the hold').toHaveText('Billing on hold (imported)');
      await expect(page.getByRole('button', { name: 'Lift billing hold…' }), 'and has no control').toHaveCount(0);
      await signOut(page);
      await signIn(page, fixtures.wall.rene);
      await page.goto(url);
      await expect(page.getByRole('heading', { name: /^Client|Packet|Engagements$/ }).first()).toBeVisible();
      await expect(page.getByRole('button', { name: 'Lift billing hold…' }), 'comms_billing has no control').toHaveCount(0);
      const refused = await page.evaluate(async ({ id, reason }) => {
        const r = await fetch(`/api/engagements/${id}/billing-hold/lift`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason }) });
        return { status: r.status, body: (await r.json()) as { error?: string; permission?: string; message?: string } };
      }, { id: held.engagementId, reason: REASON });
      expect(refused.status).toBe(403);
      expect(refused.body.error).toBe('forbidden');
      expect(refused.body.permission).toBe('engagements.billing_hold.lift');
      expect(refused.body.message).toBe('This session does not hold engagements.billing_hold.lift.');
      await page.screenshot({ path: shot('L3'), fullPage: true });
      cleared.add('L3');
      await signOut(page);

      // ── L2: the CEO lifts it with a reason; a chat artifact is refused where it was typed.
      await signIn(page, fixtures.staff);
      await page.goto(url);
      await expect(page.getByRole('heading', { name: 'Engagements' })).toBeVisible();
      await heldRow().getByRole('button', { name: 'Lift billing hold…' }).click();
      const modal = page.locator('[role=dialog]', { hasText: 'Lift the billing hold?' });
      await expect(modal).toBeVisible();
      await expect(modal.getByText(held.holdReason, { exact: false })).toBeVisible();
      const go = modal.getByRole('button', { name: 'Lift billing hold', exact: true });
      await expect(go, 'the reason is required before the press').toBeDisabled();
      await modal.locator('textarea').fill(ARTIFACT);
      await go.click();
      await expect(modal.getByText(/points into a conversation/), 'the server\'s words, under the field').toBeVisible();
      await expect(modal, 'the modal stays open').toBeVisible();
      await modal.locator('textarea').fill(REASON);
      await go.click();
      await expect(modal).toHaveCount(0);
      await expect(page.getByText('Billing hold lifted. Invoices can be raised on this engagement from now on.')).toBeVisible();
      await expect(page.getByTestId('engagement-billing-hold'), 'the re-read row carries no hold').toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Lift billing hold…' })).toHaveCount(0);
      const statuses = await page.getByTestId('engagement-status').allTextContents();
      expect(statuses.some((s) => s.includes('billing on hold')), 'no status sentence says billing on hold').toBe(false);
      await page.screenshot({ path: shot('L2'), fullPage: true });
      cleared.add('L2');
    } finally {
      for (const step of ['L1', 'L2', 'L3']) {
        const file = shots[step] ?? testInfo.outputPath(`billing-hold-${step}-${viewport}.png`);
        if (!shots[step] && !existsSync(file)) await page.screenshot({ path: file, fullPage: true }).catch(() => undefined);
        testInfo.annotations.push({ type: 'screenshot', description: keepScreenshot(`billing-hold-${step}-${viewport}`, cleared.has(step), file) });
      }
      const controls: Record<string, string> = { L1: L1_CONTROL, L2: L2_CONTROL, L3: L3_CONTROL };
      for (const step of cleared) {
        testInfo.annotations.push({ type: 'walk-step', description: `${step}|${controls[step]}|${step === 'L3' ? 'role proof: ed_coo reads the badge with no control; comms_billing has no control, POST refused 403' : ROLES}|tap` });
      }
    }
  });
});
