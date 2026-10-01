/*
 * R97 SAME-NAME PAIRS (Brian, 2026-09-29) — path C, at 390 × 844 and 1280 × 800, as the CEO fixture.
 *
 *   C1  Merge: the client page carries "Possible duplicate of <other>, compare"; Compare shows the two
 *       side by side (email, phone, businesses, engagements, last activity, portal user); a reason and
 *       Merge (the R92 pair door) join them; the banner is gone and the other record's page redirects.
 *   C2  Not a duplicate: Compare, a reason, Not a duplicate; the banner is gone from both pages.
 */
import { expect, test, type Page } from '@playwright/test';
import * as OTPAuth from 'otpauth';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { viewportKey } from './viewport';

const here = dirname(fileURLToPath(import.meta.url));
interface Persona { email: string; password: string; totpSecret: string }
interface Pair { a: string; b: string; name: string }
const fixtures = JSON.parse(readFileSync(resolve(here, '..', '.artifacts', 'fixtures.json'), 'utf8')) as {
  staff: Persona; sameName: { phone: { merge: Pair; dismiss: Pair }; desk: { merge: Pair; dismiss: Pair } };
};
const ROLE = 'ceo (contacts.merge for Merge; contacts.write for Not a duplicate)';

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

test('C1–C2: a same-name pair is merged through Compare, another is marked not a duplicate; the banners go', async ({ page }, testInfo) => {
  const who = viewportKey(testInfo) === 'desk' ? fixtures.sameName.desk : fixtures.sameName.phone;
  await signIn(page, fixtures.staff);
  const dialog = page.locator('[role=dialog]');

  // ── C1: Merge ──
  await page.goto(`/clients/${who.merge.a}`);
  const banner = page.getByTestId('duplicate-banner');
  await expect(banner).toHaveCount(1);
  await expect(banner).toContainText(`Possible duplicate of ${who.merge.name},`);
  await banner.getByTestId('duplicate-compare').click();
  const table = dialog.getByTestId('duplicate-compare-table');
  for (const label of ['Email', 'Phone', 'Businesses', 'Engagements', 'Last activity', 'Portal user']) {
    await expect(table.getByRole('rowheader', { name: label }), `Compare shows ${label}`).toBeVisible();
  }
  await dialog.getByRole('textbox').fill('One person recorded twice by the Dubsado onboarding.');
  await dialog.getByRole('button', { name: 'Merge', exact: true }).click();
  await expect(page.getByText('Merged. The other record redirects here.')).toBeVisible();
  await expect(page.getByTestId('duplicate-banner')).toHaveCount(0);
  await page.goto(`/clients/${who.merge.b}`);
  await page.waitForURL((u) => u.pathname === `/clients/${who.merge.a}`);
  testInfo.annotations.push({ type: 'walk-step', description: `C1|/clients/:id banner "Possible duplicate of <other>, compare" → "compare" (modal: Email, Phone, Businesses, Engagements, Last activity, Portal user side by side) → reason → "Merge" (the R92 pair door) → the banner is gone and the other record's page opens this one|${ROLE}|tap` });

  // ── C2: Not a duplicate ──
  await page.goto(`/clients/${who.dismiss.a}`);
  const b2 = page.getByTestId('duplicate-banner');
  await expect(b2).toContainText(`Possible duplicate of ${who.dismiss.name},`);
  await b2.getByTestId('duplicate-compare').click();
  await dialog.getByRole('textbox').fill('Two people with one name: different households on file.');
  await dialog.getByRole('button', { name: 'Not a duplicate', exact: true }).click();
  await expect(page.getByText('Marked not a duplicate. The banner is gone from both records.')).toBeVisible();
  await expect(page.getByTestId('duplicate-banner')).toHaveCount(0);
  await page.goto(`/clients/${who.dismiss.b}`);
  await expect(page.getByRole('heading', { level: 1 })).toContainText(who.dismiss.name);
  await expect(page.getByTestId('duplicate-banner'), 'gone from the other record too').toHaveCount(0);
  testInfo.annotations.push({ type: 'walk-step', description: `C2|/clients/:id banner → "compare" → reason → "Not a duplicate" → the banner is gone from this record and from the other|${ROLE}|tap` });
});
