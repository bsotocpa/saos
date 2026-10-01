/*
 * BATCH 15 (Brian, 2026-09-30) — path I, at 375, 768 and 1440 in Chromium and WebKit.
 *
 *   I1  R105: the portal checklist — each item's name on its own line with its status beside it, the
 *       Upload control full width beneath — and the Documents page passes the layout check;
 *   I2  R110: the list groups each file under its return ("Your <year> Form 1040", "<business>, <year>
 *       Form 1120-S", "Not tied to a return"), the superseded file is not there, each file says what it
 *       counts as in words, and "Something else" sits after the list;
 *   I3  R108, the portal: the withdrawn return is one line, "Withdrawn on <date>", its reason on tap in
 *       the client's words, with no phases;
 *   I4  R108, Ops: the withdrawn return is one line on the client page, the recorded reason on tap, no
 *       stepper and no controls;
 *   I5  R107: "Set final fee" in Details on a return in Engage; outside the quoted range it asks for a
 *       reason, and with one it is set.
 */
import { expect, test, type Page } from '@playwright/test';
import * as OTPAuth from 'otpauth';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkLayout } from './layout-check';
import { redeemPortalToken } from './portal-sign-in';
import { viewportKey } from './viewport';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..');
interface Persona { email: string; password: string; totpSecret: string }
interface Person {
  contactId: string; fullName: string; businessName: string; portalMagicTokens: string[];
  return1040Id: string; return1120sId: string; withdrawnId: string; taxYear: number;
  files: { on1040: string; on1120s: string; countsAs: string; loose: string; superseded: string };
  countsAsLabel: string; withdrawnReason: string;
}
const fixtures = JSON.parse(readFileSync(resolve(here, '..', '.artifacts', 'fixtures.json'), 'utf8')) as {
  staff: Persona; opsPort?: number; portalPort?: number; batch15: Record<'phone' | 'desk', Person>;
};
const OPS = `http://localhost:${fixtures.opsPort ?? 3105}`;
const PORTAL = `http://localhost:${fixtures.portalPort ?? 3106}`;
const ROLES = 'client (portal sign-in link) for I1-I3; ceo (engagements.tax.manage) for I4-I5';
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

test('I1–I5: the Documents page by return, a withdrawn return in one line, the final fee in Details', async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  const project = testInfo.project.name;
  const who = fixtures.batch15[viewportKey(testInfo)];
  const shot = testInfo.outputPath(`batch15-${project}.png`);
  const steps: string[] = [];
  let passed = false;
  try {
    // ── I1. THE CHECKLIST, AND THE PAGE THROUGH THE LAYOUT CHECK ──────────────────────────
    await redeemPortalToken(page, PORTAL, who.portalMagicTokens[0]!);
    await page.goto(`${PORTAL}/documents`);
    await expect(page.getByRole('heading', { name: 'Document Center' })).toBeVisible();
    const item = page.getByTestId('checklist-item').filter({ has: page.locator('[data-status=pending]').or(page.locator('.cl-upload')) }).first();
    await expect(item).toBeVisible();
    const li = await item.boundingBox();
    const name = await item.getByTestId('checklist-item-name').boundingBox();
    const upload = await item.locator('.cl-upload').boundingBox();
    expect(name!.width, 'the item name has the line, not a sliver of it').toBeGreaterThan(li!.width * 0.5);
    expect(Math.abs(upload!.width - li!.width), 'the Upload control is full width beneath').toBeLessThan(2);
    expect(upload!.y, 'beneath the name').toBeGreaterThan(name!.y + name!.height - 1);
    const failures = await checkLayout(page);
    expect(failures, 'the Documents page passes the layout check').toEqual([]);
    // The file input is hidden from sight but in the page (2026-10-01): a real tap on "Upload" opens the
    // file chooser, the step a person takes on a phone, never only setInputFiles behind it.
    // (Playwright counts a 1px transparent box as visible, so the walk reads what a person would see.)
    const raw = await item.getByTestId('checklist-upload').evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { w: r.width, h: r.height, opacity: getComputedStyle(el).opacity };
    });
    expect(raw.w <= 1 && raw.h <= 1 && raw.opacity === '0', `no raw file box under Upload (${raw.w}x${raw.h}, opacity ${raw.opacity})`).toBe(true);
    const chooser = page.waitForEvent('filechooser', { timeout: 10_000 });
    await item.locator('.cl-upload').click();
    expect((await chooser).isMultiple(), 'a tap on Upload opens the file chooser, several files at once').toBe(true);
    steps.push(`I1|portal /documents: data-testid checklist-item — checklist-item-name on its own line (wider than half the row), the status chip beside it, label.cl-upload "Upload" full width beneath, no raw file box, and a tap on "Upload" opens the file chooser; checkLayout() empty at ${project}|${ROLES}|tap`);

    // ── I2. THE LIST BY RETURN ────────────────────────────────────────────────────────────
    const groups = page.getByTestId('document-group');
    const titles = (await groups.locator('h3').allInnerTexts()).map((t) => t.trim());
    expect(titles, 'individual return, then the business return, then the rest').toEqual([
      `Your ${who.taxYear} Form 1040`, `${who.businessName}, ${who.taxYear} Form 1120-S`, 'Not tied to a return',
    ]);
    const in1040 = await groups.nth(0).getByTestId('document-row').allInnerTexts();
    expect(in1040.some((t) => t.includes(`synthetic-w2-employer-${viewportKey(testInfo)}.pdf`)), 'the file filed against the 1040').toBe(true);
    expect(in1040.some((t) => t.includes(`synthetic-1099-int-${viewportKey(testInfo)}.pdf`)), 'the file that answers its checklist').toBe(true);
    await expect(groups.nth(1).getByText(`synthetic-1120s-ledger-${viewportKey(testInfo)}.pdf`)).toBeVisible();
    await expect(groups.nth(2).getByText(`synthetic-receipt-${viewportKey(testInfo)}.pdf`)).toBeVisible();
    await expect(page.getByText(`synthetic-old-scan-${viewportKey(testInfo)}.pdf`), 'a superseded file is not the client\'s to see').toHaveCount(0);
    const counted = page.getByTestId('document-row').filter({ hasText: `synthetic-1099-int-${viewportKey(testInfo)}.pdf` });
    await expect(counted.getByTestId('doc-counts-as')).toHaveText(`Counts as: ${who.countsAsLabel}`);
    const loose = page.getByTestId('document-row').filter({ hasText: `synthetic-receipt-${viewportKey(testInfo)}.pdf` });
    await expect(loose.getByTestId('doc-counts-as-none')).toHaveText('Not matched to a checklist item');
    const list = await page.getByTestId('documents-list').boundingBox();
    const other = await page.getByTestId('something-else').boundingBox();
    expect(other!.y, '"Something else" sits after the list').toBeGreaterThan(list!.y + list!.height - 1);
    await expect(page.getByTestId('something-else').getByRole('heading', { name: 'Something else' })).toBeVisible();
    steps.push(`I2|portal /documents: data-testid document-group h3 "Your <year> Form 1040", "<business>, <year> Form 1120-S", "Not tied to a return"; the superseded file absent; doc-counts-as "Counts as: <item>", doc-counts-as-none "Not matched to a checklist item"; data-testid something-else ("Something else") after documents-list|${ROLES}|tap`);

    // ── I3. THE WITHDRAWN RETURN ON THE PORTAL ────────────────────────────────────────────
    await page.goto(`${PORTAL}/`);
    const wrow = page.getByTestId('service-withdrawn');
    await expect(wrow).toHaveCount(1);
    await expect(wrow.locator('summary')).toContainText(`${who.taxYear - 1}`);
    await expect(wrow.locator('summary')).toContainText('Withdrawn on');
    await expect(wrow.getByTestId('service-phases'), 'no phases on a withdrawn return').toHaveCount(0);
    await wrow.locator('summary').click();
    await expect(wrow.getByTestId('service-withdrawn-reason')).toHaveText('Closed by Soto Accounting. Ask us if you have any questions.');
    await expect(page.getByText(who.withdrawnReason), 'the staff\'s words stay in Ops').toHaveCount(0);
    steps.push(`I3|portal / (Home) services: data-testid service-withdrawn — one line "<year> … · Withdrawn on <date>", no phases; tapped open, service-withdrawn-reason in the client's words|${ROLES}|tap`);

    // ── I4. THE WITHDRAWN RETURN IN OPS ───────────────────────────────────────────────────
    await opsSignIn(page);
    await page.goto(`${OPS}/clients/${who.contactId}`);
    const line = page.getByTestId(`withdrawn-return-${who.withdrawnId}`);
    await expect(line.locator('summary')).toContainText(`${who.taxYear - 1} 1040`);
    await expect(line.locator('summary')).toContainText('Withdrawn on');
    await expect(line.locator('button'), 'no controls').toHaveCount(0);
    await expect(line.locator('[data-testid=return-stepper]'), 'no stepper').toHaveCount(0);
    await line.locator('summary').click();
    await expect(page.getByTestId(`withdrawn-reason-${who.withdrawnId}`)).toHaveText(who.withdrawnReason);
    steps.push(`I4|Ops /clients/:id Returns card: data-testid withdrawn-return-<id> — one line "<year> 1040 · Withdrawn on <date>", no stepper, no buttons; tapped open, the recorded reason|${ROLES}|tap`);

    // ── I5. SET FINAL FEE IN DETAILS, IN ENGAGE ───────────────────────────────────────────
    const row1040 = page.locator('.quote-line', { hasText: `${who.taxYear} 1040` }).first();
    const details = row1040.getByTestId('return-details');
    const set = row1040.getByTestId('details-set-final-fee');
    await expect(set, 'in Details while the return is in Engage').toBeVisible();
    const stage = await page.evaluate(async (id) => (await (await fetch(`/api/tax-engagements/${id}`)).json()).taxEngagement.stage, who.return1040Id);
    expect(stage, 'the return is in Engage').toBe('intake_started');
    await set.click();
    const dialog = page.locator('[role=dialog]');
    await dialog.getByLabel(/Final fee/).fill('99999.00');
    await dialog.getByRole('button', { name: 'Set final fee', exact: true }).click();
    await expect(dialog.locator('.field-error, [role=alert]').first(), 'outside the quoted range, a reason first').toBeVisible();
    await dialog.getByLabel('Reason').fill('Synthetic: the client added two rental properties after the quote.');
    await dialog.getByRole('button', { name: 'Set final fee', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(details).toContainText('Fee on file: $99,999.00');
    steps.push(`I5|Ops /clients/:id stepper Details: data-testid details-set-final-fee "Set final fee" on a return in Engage — outside the quoted range the modal refuses without a reason, with one the fee is set ("Fee on file: $99,999.00")|${ROLES}|tap`);

    await page.screenshot({ path: shot, fullPage: true });
    passed = true;
  } finally {
    if (!existsSync(shot)) await page.screenshot({ path: shot, fullPage: true }).catch(() => undefined);
    testInfo.annotations.push({ type: 'screenshot', description: keepScreenshot(`batch15-${project}`, passed, shot) });
    for (const s of steps) testInfo.annotations.push({ type: 'walk-step', description: s });
  }
});
