/*
 * PATH B, THE 990 VARIANT (Brian, 2026-09-26, R66) — path N, at 390 × 844 and 1280 × 800.
 *
 * Ana-Maria's first SAOS returns are three Form 990s due 2026-11-15. This is that return's shape,
 * on a synthetic Illinois nonprofit the fixture builds per viewport with its 990 at ready to file
 * (apps/api/scripts/e2e-fixtures/path-b-990.ts — the letter, the lock, the fee at the book's own
 * 990 amount, the stages; none of them the subject here), and then taps:
 *
 *   N1  Record extension: the Form select opens on 8868 (an exempt organization extends on 8868, never
 *       7004), the day is today; the row's badge reads Form 8868 and the extended deadline the route
 *       DERIVED from the return type and the fiscal year end — November of the year after the tax
 *       year, never typed.
 *   N2  Upload the signed 8879: the Form select opens on 8879-TE (the exempt organization's 8879); the
 *       row then reads "8879-TE on file, signed <date>".
 *   N3  Mark filed: the modal starts on federal + IL (the entity's state); IL is removed — a 990 files
 *       federally alone, the Illinois AG report is on its own clock — and the return files e-file
 *       with the preparer's PTIN.
 *   N4  The ATX E-Files export (the committed synthetic fixture plus this organization's 990 Federal
 *       Accepted row, matched on the EIN's last four and the folded entity name) uploaded on
 *       /efile-acks and released: the return completes, the engagement closes, the row reads Accepted.
 *
 * Each viewport walks its own organization (path990.phone / path990.desk), because the walk files and
 * completes its return once.
 */
import { expect, test, type Page } from '@playwright/test';
import * as OTPAuth from 'otpauth';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { viewportKey } from './viewport';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..');
interface Persona { email: string; password: string; totpSecret: string }
interface Org { contactId: string; businessId: string; taxEngagementId: string; taxYear: number; orgName: string; einLast4: string; einDigits: string; state: string }
const fixtures = JSON.parse(readFileSync(resolve(here, '..', process.env.E2E_ARTIFACTS ?? '.artifacts', 'fixtures.json'), 'utf8')) as {
  port: number;
  staff: Persona;
  path990: { phone: Org; desk: Org; preparer: { id: string; name: string } };
};
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
const ROLES = { returnControls: 'tax_preparer, ceo (engagements.tax.manage)', efile: 'ceo (efile.manage)' };
const PDF = { mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 synthetic harness document - no real client data\n%%EOF') };
/** A calendar day in the words Ops prints it — the same Intl call apps/internal/lib/dates.ts makes. */
const dayText = (iso: string): string =>
  new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(`${iso.slice(0, 10)}T00:00:00Z`));

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
/** A read of the API from the signed-in session, for assertions on state the screen does not print. */
async function read(page: Page, path: string): Promise<Record<string, unknown>> {
  return page.evaluate(async (p) => (await fetch(`/api${p}`)).json().catch(() => ({})), path);
}
function keepScreenshot(name: string, passed: boolean, file: string): string {
  const dir = passed ? resolve(here, '..', '.artifacts', today) : resolve(root, 'tasks', 'walks', today);
  mkdirSync(dir, { recursive: true });
  const target = resolve(dir, `${name}.png`);
  if (existsSync(file)) copyFileSync(file, target);
  return target;
}

test.describe('Path B, the 990 variant', () => {
  test('N1–N4: the 990 on extension (8868), the 8879-TE, filed federal alone, accepted through the ATX export, completed', async ({ page }, testInfo) => {
    const viewport = viewportKey(testInfo);
    test.setTimeout(300_000);
    const org = viewport === 'desk' ? fixtures.path990.desk : fixtures.path990.phone;
    const te = org.taxEngagementId;
    const shot = testInfo.outputPath(`path-b-990-${viewport}.png`);
    const steps: string[] = [];
    let passed = false;
    try {
      const clientPage = `/clients/${org.contactId}`;
      const dialog = page.locator('[role=dialog]');
      const card = page.locator('section.card', { has: page.getByRole('heading', { name: 'Returns' }) });
      const returnRow = card.locator('.quote-line', { hasText: `${org.taxYear} 990` });

      await signIn(page, fixtures.staff);
      await page.goto(clientPage);
      await expect(page.getByRole('heading', { name: 'Returns' })).toBeVisible();
      await expect(returnRow, 'the fixture organization\'s 990 is on the card').toBeVisible();

      // ── N1. RECORD EXTENSION: 8868, THE DERIVED DEADLINE ───────────────────────────────
      await returnRow.getByTestId('record-extension').click();
      await expect(dialog).toBeVisible();
      await expect(dialog.getByText('A 990 extends on Form 8868 (exempt organization)', { exact: false }), 'the modal says which form the family takes').toBeVisible();
      await expect(dialog.getByTestId('extension-form').locator('select'), 'the select opens on 8868, never 7004').toHaveValue('8868');
      await dialog.getByLabel('Date filed').fill(today);
      await dialog.getByRole('button', { name: 'Record extension' }).click();
      await expect(dialog).toHaveCount(0);
      const extended = (await read(page, `/tax-engagements/${te}`)).taxEngagement as Record<string, unknown>;
      expect(extended.extension_form, 'recorded on 8868').toBe('8868');
      expect(String(extended.extended_deadline).slice(0, 7), 'the extended deadline DERIVED: November of the year after the tax year (the fifth month + six), never typed').toBe(`${org.taxYear + 1}-11`);
      await expect(returnRow.getByText(`Extended · Form 8868 · deadline ${dayText(String(extended.extended_deadline))}`), 'the badge reads the form and the derived deadline').toBeVisible();
      steps.push(`N1|/clients/:id Returns card, button "Record extension" (modal: "Extension form" select opening on Form 8868 (exempt organization), "Date filed" today) → badge "Extended · Form 8868 · deadline <derived>"|${ROLES.returnControls}|tap`);

      // ── N2. THE SIGNED 8879-TE ──────────────────────────────────────────────────────────
      // The paper went to the organization across the desk first (R53): under the stepper (R50, on in the
      // harness) the upload is offered only once the 8879 is recorded as sent; on the row both show at once.
      await returnRow.getByTestId('record-8879-sent').click();
      await expect(dialog).toBeVisible();
      await dialog.getByTestId('sent-8879-method').locator('select').selectOption('in_office');
      await dialog.getByRole('button', { name: 'Record 8879 sent' }).click();
      await expect(dialog).toHaveCount(0);
      const uploadForm = returnRow.getByTestId('upload-8879-form');
      await expect(uploadForm.getByTestId('f8879-variant').locator('select'), 'the Form select opens on 8879-TE for a 990').toHaveValue('8879-TE');
      await uploadForm.locator('input[type=file]').setInputFiles({ name: `HARNESS-990-8879TE-SIGNED-${viewport}.pdf`, ...PDF });
      await uploadForm.getByLabel('Signed on').fill(today);
      await expect(uploadForm.getByLabel('PTIN holder'), 'the PTIN holder is the assigned preparer').toHaveValue(fixtures.path990.preparer.id);
      await uploadForm.getByTestId('upload-signed-8879').click();
      await expect(uploadForm, 'the upload leaves once the 8879 is on file').toHaveCount(0);
      const stepper = ((await read(page, '/auth/me')) as { switches?: { returnStepper?: string } }).switches?.returnStepper === 'on';
      if (!stepper) {
        // The row's own words; with the stepper on, the 8879 step is the other component's to print and the API is read below.
        await expect(returnRow.getByText(`8879-TE on file, signed ${dayText(today)}`, { exact: false }), 'the row names the form on file').toBeVisible();
      }
      const authorized = (await read(page, `/tax-engagements/${te}`)).taxEngagement as Record<string, unknown>;
      expect(authorized.f8879_variant, 'stored on the document row, read back on the return').toBe('8879-TE');
      expect(authorized.f8879_signed_on, 'the signed day is the day on the scan').toBe(today);
      steps.push(`N2|/clients/:id Returns card, input[type=file] "Signed 8879 (scan)" + "Signed on" + "PTIN holder" + "Form" select opening on Form 8879-TE + button "Upload the signed 8879" → the row reads "8879-TE on file, signed <date>"|${ROLES.returnControls}|tap`);

      // ── N3. MARK FILED, FEDERAL ALONE ───────────────────────────────────────────────────
      await returnRow.getByRole('button', { name: 'Mark filed' }).click();
      await expect(dialog).toBeVisible();
      await expect(dialog.getByLabel('Filed on')).toHaveValue(today);
      await expect(dialog.getByLabel(/PTIN holder/)).toHaveValue(fixtures.path990.preparer.id);
      await expect(dialog.getByRole('button', { name: `Remove ${org.state}` }), 'the modal starts on the entity\'s state').toBeVisible();
      await dialog.getByRole('button', { name: `Remove ${org.state}` }).click();
      await expect(dialog.getByTestId(`filing-method-${org.state}`)).toHaveCount(0);
      await expect(dialog.getByTestId('filing-method-federal'), 'the IRS takes the 990 electronically').toHaveValue('efile');
      await dialog.getByRole('button', { name: 'Mark filed' }).click();
      await expect(dialog).toHaveCount(0);
      await expect(returnRow.getByText(`filed ${dayText(today)}`, { exact: false })).toBeVisible();
      const filed = (await read(page, `/tax-engagements/${te}`)) as { taxEngagement: Record<string, unknown>; declared_jurisdictions: string[] };
      expect(filed.taxEngagement.stage).toBe('filed');
      expect(filed.declared_jurisdictions, 'federal alone: the Illinois AG report is on its own clock').toEqual(['federal']);
      steps.push(`N3|/clients/:id Returns card, button "Mark filed" (modal: "Filed on" today, PTIN holder, chip "Remove ${org.state}", filing method E-filed for federal) → the row reads filed|${ROLES.returnControls}|tap`);

      // ── N4. THE ATX EXPORT: THE 990 FEDERAL ACCEPTED ROW, RELEASED; COMPLETED ─────────
      const ackFile = `E-Files-990-${viewport}.csv`;
      const atxFixture = readFileSync(resolve(root, 'apps', 'api', 'test', 'fixtures', 'atx', 'ATX_EFiles_synthetic.csv'), 'utf8').replace(/\s+$/, '');
      const atxDate = `${Number(today.slice(5, 7))}/${Number(today.slice(8, 10))}/${today.slice(0, 4)}`;
      const report = [
        atxFixture,
        `${org.orgName},,,${org.einDigits},hp990${org.einLast4}${viewport}k7q2m1,Federal,990,Federal,Accepted,${atxDate} 3:12:07 PM,TBD,0,Zero Balance,,0,Ogden`,
      ].join('\n');
      await page.goto('/efile-acks');
      await expect(page.getByRole('heading', { name: 'E-file acknowledgments' })).toBeVisible();
      await page.locator('input[type=file]').setInputFiles({ name: ackFile, mimeType: 'text/csv', buffer: Buffer.from(report, 'utf8') });
      await expect(page.getByRole('status')).toContainText('1 will send');
      await expect(page.getByRole('status'), 'the firm-wide rows are counted, not tasked').toContainText('34 unmatched');
      await expect(page.getByRole('heading', { name: ackFile }), 'the report opened with its rows').toBeVisible();
      const rowsText = await page.evaluate(() => document.body.innerText);
      expect(rowsText, 'the 990 row matched the organization').toMatch(/990[\s\S]*Will send/);
      expect(rowsText, 'the identifier shows as its last four only').toContain(`•••••${org.einLast4}`);
      expect(rowsText, 'no full identifier reaches the screen').not.toContain(org.einDigits);
      const acked = (await read(page, `/tax-engagements/${te}`)).taxEngagement as Record<string, unknown>;
      expect(acked.stage, 'federal was the only jurisdiction: the acknowledgment completes the return').toBe('completed');
      expect(acked.federal_accepted_on, 'the IRS accepted the 990').toBeTruthy();
      await page.getByRole('button', { name: /^Release/ }).first().click();
      await page.locator('[role=dialog]').getByRole('button', { name: /^Release 1/ }).click();
      await expect(page.getByRole('status')).toContainText('Released: 1 queued to send');
      const engagements = (await read(page, `/engagements?contactId=${org.contactId}`)).engagements as Array<Record<string, unknown>>;
      expect(engagements.find((e) => e.service_line === 'tax')!.status, 'every return on the engagement accepted closes it').toBe('completed');
      await page.goto(clientPage);
      await expect(page.getByRole('heading', { name: 'Returns' })).toBeVisible();
      await expect(card.getByTestId('jurisdiction-line-federal'), 'the completed row reads its acceptance').toContainText(`Accepted ${dayText(today)}`);
      steps.push(`N4|/efile-acks input[type=file] "Upload ATX report" (the ATX E-Files export: the committed fixture + the organization's 990 Federal Accepted row, matched on the EIN's last four and the folded name), status "1 will send … 34 unmatched", button "Release 1 to clients" + modal "Release 1"; the return completed, the engagement completed, jurisdiction-line-federal reads "Accepted <date>"|${ROLES.efile}|tap`);

      await page.screenshot({ path: shot, fullPage: true });
      passed = true;
    } finally {
      if (!existsSync(shot)) await page.screenshot({ path: shot, fullPage: true }).catch(() => undefined);
      testInfo.annotations.push({ type: passed ? 'artifact' : 'failure-screenshot', description: keepScreenshot(`path-b-990-${viewport}`, passed, shot) });
      for (const s of steps) testInfo.annotations.push({ type: 'walk-step', description: s });
    }
  });
});
