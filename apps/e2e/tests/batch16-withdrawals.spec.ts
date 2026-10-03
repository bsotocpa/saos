/*
 * BATCH 16 (Brian, 2026-10-02) — R117, portal withdrawals: path I, steps I6-I7, at 375, 768 and 1440 in
 * Chromium and WebKit.
 *
 *   I6  Ops: a return withdrawn as the firm's own record (a duplicate) and one withdrawn as the client's
 *       decision, each from its engagement's Withdraw (behind More below 768) by the kind's own button;
 *       both are one-line withdrawn returns in Ops, the firm's own record marked "not on the client's portal";
 *   I7  the portal: only the client's withdrawal is there, one line with the fixed sentence on tap; the
 *       firm's own record is nowhere (Home, Documents), and the client's file that sat on it is listed as
 *       not tied to a return.
 *   I8  R118, Ops: the CEO corrects each withdrawal's kind from its line ("Correct the kind…", a reason
 *       required): the client's one to our own record, the duplicate to the client's work ended; the
 *       "not on the client's portal" mark follows the kind;
 *   I9  R118, the portal follows: the duplicate's line is there with the fixed sentence, the other is gone.
 */
import { expect, test, type Page } from '@playwright/test';
import * as OTPAuth from 'otpauth';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkLayout } from './layout-check';
import { openMore } from './more';
import { redeemPortalToken } from './portal-sign-in';
import { viewportKey } from './viewport';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..');
interface Persona { email: string; password: string; totpSecret: string }
interface Side { engagementId: string; returnId: string; year: number; fileName: string }
interface Person { contactId: string; portalMagicTokens: string[]; dup: Side; kept: Side }
const fixtures = JSON.parse(readFileSync(resolve(here, '..', process.env.E2E_ARTIFACTS ?? '.artifacts', 'fixtures.json'), 'utf8')) as {
  staff: Persona; opsPort?: number; portalPort?: number; batch16: Record<'phone' | 'desk', Person>;
};
const OPS = `http://localhost:${fixtures.opsPort ?? 3105}`;
const PORTAL = `http://localhost:${fixtures.portalPort ?? 3106}`;
const ROLES = 'ceo (engagements.write) for I6; client (portal sign-in link) for I7 and I9; ceo (engagements.tax.withdrawal_kind.correct, explicit-only) for I8';
const chicagoToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());

async function opsSignIn(page: Page): Promise<void> {
  const { email, password, totpSecret } = fixtures.staff;
  const code = new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(totpSecret) }).generate();
  await page.goto(`${OPS}/login`);
  const status = await page.evaluate(async ({ email, password, totp }) => {
    const r = await fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password, totp }) });
    sessionStorage.setItem('saos_staff_authed', '1');
    return r.status;
  }, { email, password, totp: code });
  expect(status).toBe(200);
}
function keepScreenshot(name: string, passed: boolean, file: string): string {
  const dir = passed ? resolve(here, '..', '.artifacts', chicagoToday()) : resolve(root, 'tasks', 'walks', chicagoToday());
  mkdirSync(dir, { recursive: true });
  const target = resolve(dir, `${name}.png`);
  if (existsSync(file)) copyFileSync(file, target);
  return target;
}

/** R118: correct one withdrawn return's kind from its line, a reason first. */
async function correctKind(page: Page, side: Side, button: string, reason: string): Promise<void> {
  const line = page.getByTestId(`withdrawn-return-${side.returnId}`);
  await line.locator('summary').click();
  await line.getByTestId(`withdrawal-kind-correct-${side.returnId}`).click();
  const modal = page.locator('[role=dialog]');
  await expect(modal.getByRole('button', { name: button }), 'no correction without a reason').toBeDisabled();
  await modal.locator('textarea').fill(reason);
  await modal.getByRole('button', { name: button }).click();
  await expect(modal).toHaveCount(0);
}

/** Withdraw one engagement from the client page, by the kind's own button in the modal. */
async function withdraw(page: Page, side: Side, button: string, reason: string): Promise<void> {
  const row = page.getByTestId(`engagement-row-${side.engagementId}`);
  await expect(row).toBeVisible();
  await openMore(row);
  await row.getByRole('button', { name: 'Withdraw', exact: true }).click();
  const modal = page.locator('[role=dialog]');
  await expect(modal.getByRole('heading', { name: 'Withdraw this engagement?' })).toBeVisible();
  await expect(modal.getByRole('button', { name: button }), 'no kind without a reason').toBeDisabled();
  await modal.locator('textarea').fill(reason);
  await modal.getByRole('button', { name: button }).click();
  await expect(modal).toHaveCount(0);
}

test('I6–I7: a withdrawal of the firm\'s own record is hidden from the portal; the client\'s is one line', async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  const project = testInfo.project.name;
  const who = fixtures.batch16[viewportKey(testInfo)];
  const shot = testInfo.outputPath(`batch16-${project}.png`);
  const steps: string[] = [];
  let passed = false;
  try {
    // ── I6. OPS: TWO WITHDRAWALS, EACH BY ITS KIND ────────────────────────────────────────
    await opsSignIn(page);
    await page.goto(`${OPS}/clients/${who.contactId}`);
    await withdraw(page, who.dup, 'Withdraw: our own record', 'Synthetic: a duplicate of the real return.');
    await withdraw(page, who.kept, "Withdraw: the client's work ended", 'Synthetic: the client filed with another preparer.');
    const dupLine = page.getByTestId(`withdrawn-return-${who.dup.returnId}`);
    const keptLine = page.getByTestId(`withdrawn-return-${who.kept.returnId}`);
    await expect(dupLine.locator('summary')).toContainText(`${who.dup.year} 1040`);
    await expect(page.getByTestId(`withdrawn-hidden-${who.dup.returnId}`), 'Ops says the client cannot see it').toHaveText(/not on the client.s portal/);
    await expect(keptLine.locator('summary')).toContainText('Withdrawn on');
    await expect(page.getByTestId(`withdrawn-hidden-${who.kept.returnId}`), "the client's withdrawal is not marked").toHaveCount(0);
    expect(await checkLayout(page), 'the client page passes the layout check').toEqual([]);
    steps.push(`I6|Ops /clients/:id engagement-row-<id> Withdraw (behind More below 768) → modal "Withdraw: our own record" for the duplicate and "Withdraw: the client's work ended" for the other, each disabled until a reason is typed; both become withdrawn-return-<id> lines, the duplicate's with withdrawn-hidden-<id> "not on the client's portal"; checkLayout() empty at ${project}|${ROLES}|tap`);

    // ── I7. THE PORTAL: ONLY THE CLIENT'S WITHDRAWAL ──────────────────────────────────────
    await redeemPortalToken(page, PORTAL, who.portalMagicTokens[0]!);
    await page.goto(`${PORTAL}/`);
    const lines = page.getByTestId('service-withdrawn');
    await expect(lines, "one withdrawn line: the client's").toHaveCount(1);
    await expect(lines.locator('summary')).toContainText(`${who.kept.year}`);
    await expect(page.getByText(`${who.dup.year}`), 'the duplicate year is nowhere on Home').toHaveCount(0);
    await lines.locator('summary').click();
    await expect(lines.getByTestId('service-withdrawn-reason')).toHaveText('Closed by Soto Accounting. Ask us if you have any questions.');
    await expect(page.getByText('Synthetic: a duplicate'), "the staff's words stay in Ops").toHaveCount(0);
    expect(await checkLayout(page), 'Home passes the layout check').toEqual([]);

    await page.goto(`${PORTAL}/documents`);
    await expect(page.getByRole('heading', { name: 'Document Center' })).toBeVisible();
    const loose = page.getByTestId('document-group').filter({ has: page.getByRole('heading', { name: 'Not tied to a return' }) });
    await expect(loose.getByText(who.dup.fileName), "the client's file stays, not tied to a return").toBeVisible();
    await expect(page.getByTestId('document-group').filter({ has: page.getByRole('heading', { name: new RegExp(`${who.dup.year} Form 1040`) }) }), 'no group for the duplicate').toHaveCount(0);
    expect(await checkLayout(page), 'Documents passes the layout check').toEqual([]);
    steps.push(`I7|portal / (Home) service-withdrawn: one line, the client's withdrawal, tapped open "Closed by Soto Accounting. Ask us if you have any questions."; the duplicate's year nowhere; portal /documents: the duplicate's file under "Not tied to a return", no group for the duplicate; checkLayout() empty on both at ${project}|${ROLES}|tap`);

    // ── I8. OPS: THE CEO CORRECTS EACH KIND (R118) ────────────────────────────────────────
    await opsSignIn(page);
    await page.goto(`${OPS}/clients/${who.contactId}`);
    await expect(page.getByTestId(`withdrawn-return-${who.kept.returnId}`)).toBeVisible();
    await correctKind(page, who.kept, 'Correct to: our own record', 'Synthetic: on a second look this one was a duplicate too.');
    await expect(page.getByTestId(`withdrawn-hidden-${who.kept.returnId}`), 'now our own record: marked').toBeVisible();
    await correctKind(page, who.dup, "Correct to: the client's work ended", 'Synthetic: the client did end this one; the wrong button was pressed.');
    // R119: an absence is read only after a positive sign: the record says the new kind, and the
    // reloaded page shows the line, before the mark's absence counts.
    await expect.poll(async () => page.evaluate(async ({ cid, id }) => {
      const r = await (await fetch(`/api/tax-engagements?contactId=${cid}`)).json();
      return (r.taxEngagements as Array<{ id: string; withdrawal_kind: string | null }>).find((t) => t.id === id)?.withdrawal_kind ?? null;
    }, { cid: who.contactId, id: who.dup.returnId }), { message: "the record reads the client's kind" }).toBe('client');
    await page.reload();
    await expect(page.getByTestId(`withdrawn-return-${who.dup.returnId}`).locator('summary')).toContainText(`${who.dup.year} 1040`);
    await expect(page.getByTestId(`withdrawn-hidden-${who.dup.returnId}`), "now the client's: not marked").toHaveCount(0);
    expect(await checkLayout(page), 'the client page passes the layout check').toEqual([]);
    steps.push(`I8|Ops /clients/:id withdrawn-return-<id> opened → withdrawal-kind-correct-<id> "Correct the kind…" → modal "Correct to: our own record" / "Correct to: the client's work ended", disabled until a reason is typed; the line's withdrawn-hidden-<id> mark follows the kind; checkLayout() empty at ${project}|${ROLES}|tap`);

    // ── I9. THE PORTAL FOLLOWS (R118) ─────────────────────────────────────────────────────
    // The client's portal session from I7 is still in this browser (its sign-in link is spent).
    await page.goto(`${PORTAL}/`);
    const after = page.getByTestId('service-withdrawn');
    await expect(after, 'one withdrawn line: the corrected duplicate').toHaveCount(1);
    await expect(after.locator('summary')).toContainText(`${who.dup.year}`);
    await expect(after.locator('summary'), 'the other is gone').not.toContainText(`${who.kept.year}`);
    await after.locator('summary').click();
    await expect(after.getByTestId('service-withdrawn-reason')).toHaveText('Closed by Soto Accounting. Ask us if you have any questions.');
    steps.push(`I9|portal / (Home) service-withdrawn: after the corrections, one line, the duplicate's year, tapped open "Closed by Soto Accounting. Ask us if you have any questions."; the other year gone|${ROLES}|tap`);

    await page.screenshot({ path: shot, fullPage: true });
    passed = true;
  } finally {
    if (!existsSync(shot)) await page.screenshot({ path: shot, fullPage: true }).catch(() => undefined);
    testInfo.annotations.push({ type: 'screenshot', description: keepScreenshot(`batch16-${project}`, passed, shot) });
    for (const s of steps) testInfo.annotations.push({ type: 'walk-step', description: s });
  }
});
