/*
 * R96 "COUNTS AS" (Brian, 2026-09-29) — path K, at 390 × 844 and 1280 × 800.
 *
 *   K1  Ops, the CEO: on the client page's Documents card, a file on file before the return's
 *       checklist existed takes "Counts as…" → an item → Save; the row reads "counts as <item>".
 *   K2  The client, in the portal: on Documents, their own file already sent takes "This file is
 *       for…" → an item → Save; the row reads "Counts as: <item>", and the checklist card reads the
 *       item received.
 *
 * The client, the accepted return and the two files are the fixture's (apps/api/scripts/e2e-fixtures/
 * counts-as.ts); every match is a tap.
 */
import { expect, test, type Page } from '@playwright/test';
import { redeemPortalToken } from './portal-sign-in';
import * as OTPAuth from 'otpauth';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { viewportKey } from './viewport';

const here = dirname(fileURLToPath(import.meta.url));
interface Persona { email: string; password: string; totpSecret: string }
interface Person { contactId: string; fullName: string; opsDocId: string; portalDocId: string; portalMagicTokens: string[] }
const fixtures = JSON.parse(readFileSync(resolve(here, '..', process.env.E2E_ARTIFACTS ?? '.artifacts', 'fixtures.json'), 'utf8')) as {
  staff: Persona; portalPort?: number; countsAs: { phone: Person; desk: Person };
};
const PORTAL = `http://localhost:${fixtures.portalPort ?? 3106}`;

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

test('K1–K2: a file on file counts as a checklist item, matched from Ops and by the client in the portal', async ({ page }, testInfo) => {
  const who = viewportKey(testInfo) === 'desk' ? fixtures.countsAs.desk : fixtures.countsAs.phone;

  // ── K1: Ops ──
  await signIn(page, fixtures.staff);
  await page.goto(`/clients/${who.contactId}`);
  const select = page.getByTestId(`counts-as-select-${who.opsDocId}`);
  await expect(select, 'the control is on the unmatched file').toBeVisible();
  const option = select.locator('option').nth(1);
  const label = ((await option.textContent()) ?? '').replace(/^\d{4} \S+: /, '');
  await select.selectOption({ index: 1 });
  await page.getByTestId(`counts-as-save-${who.opsDocId}`).click();
  await expect(page.getByTestId(`document-counts-as-${who.opsDocId}`)).toHaveText(` · counts as ${label}`);
  await expect(page.getByTestId(`counts-as-select-${who.opsDocId}`), 'the control is gone once matched').toHaveCount(0);
  testInfo.annotations.push({ type: 'walk-step', description: 'K1|/clients/:id Documents card: a file on file before the checklist, select "Counts as…" → a pending checklist item → "Save" → the row reads "counts as <item>"|ceo (documents.write)|tap' });

  // ── K2: the portal ──
  await redeemPortalToken(page, PORTAL, who.portalMagicTokens[0]!);
  await page.goto(`${PORTAL}/documents`);
  await expect(page.getByRole('heading', { name: 'Document Center' })).toBeVisible();
  const row = page.getByTestId('document-row').filter({ hasText: 'synthetic-client-file.pdf' });
  const pick = row.getByTestId('doc-counts-as-select');
  await expect(pick, 'the client can say what the file is for').toBeVisible();
  const clientLabel = ((await pick.locator('option').nth(1).textContent()) ?? '').replace(/^\d{4} \S+: /, '');
  await pick.selectOption({ index: 1 });
  await row.getByTestId('doc-counts-as-save').click();
  await expect(row.getByTestId('doc-counts-as')).toHaveText(`Counts as: ${clientLabel}`);
  await expect(page.getByTestId('document-row').filter({ hasText: 'synthetic-sent-before-the-checklist.pdf' }).getByTestId('doc-counts-as'), 'the Ops match reads here too').toHaveText(`Counts as: ${label}`);
  testInfo.annotations.push({ type: 'walk-step', description: 'K2|portal /documents: the client\'s file already sent, select "This file is for…" → a pending checklist item → "Save" → the row reads "Counts as: <item>"; the file Ops matched reads the same|the client|tap' });
});
