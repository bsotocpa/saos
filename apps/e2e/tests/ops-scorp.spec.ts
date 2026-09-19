/*
 * PAGE FIVE: the first real-data run, rehearsed (2026-09-12, Brian's check e). The fixture walked
 * the S corporation through the routes: business on the owner's record, business-tax quote with
 * the deposit overridden to $0, accepted (the return record exists, Schedule B resolved), packet
 * assembled, onboarding questionnaire submitted from the portal, a document filed. This page
 * reads the Ops client page as Brian will on Monday and asks the API what the page would.
 */
import { expect, test, type Page } from '@playwright/test';
import * as OTPAuth from 'otpauth';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..');
const fixtures = JSON.parse(readFileSync(resolve(here, '..', '.artifacts', 'fixtures.json'), 'utf8')) as {
  staff: { email: string; password: string; totpSecret: string };
  scorp: { contactId: string; businessId: string; quoteId: string; engagementId: string; taxEngagementId: string; packetCodes: string[]; documentId: string; markers: { business: string; document: string } };
};
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());

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
async function ask(page: Page, path: string): Promise<{ status: number; json: Record<string, unknown> }> {
  return page.evaluate(async (p) => { const r = await fetch(`/api${p}`); return { status: r.status, json: await r.json().catch(() => ({})) }; }, path);
}
function keepScreenshot(name: string, passed: boolean, file: string): string {
  const dir = passed ? resolve(here, '..', '.artifacts', today) : resolve(root, 'tasks', 'walks', today);
  mkdirSync(dir, { recursive: true });
  const target = resolve(dir, `${name}.png`);
  if (existsSync(file)) copyFileSync(file, target);
  return target;
}

test.describe('Ops → client page, the S corporation', () => {
  test('the 1120S engagement, Schedule B, the $0 deposit, the return record and the document are there', async ({ page }, testInfo) => {
    const viewport = testInfo.project.name;
    const shot = testInfo.outputPath(`scorp-${viewport}.png`);
    let passed = false;
    try {
      await signIn(page);
      await page.goto(`/clients/${fixtures.scorp.contactId}`);
      await expect(page.getByRole('heading', { name: /Documents \(/ })).toBeVisible();
      await page.waitForTimeout(1500);
      const text = await page.evaluate(() => document.body.innerText);

      expect(text, 'the entity is on the page').toContain(fixtures.scorp.markers.business);
      expect(text, 'the business return is the engagement').toMatch(/1120-S|Business Tax/);
      expect(fixtures.scorp.packetCodes, 'the packet resolved Schedule B and not A').toEqual(['B']);
      expect(text, 'the packet is on the page with its schedule').toMatch(/Packet\s*B\b/);
      expect(text, 'the document is filed').toContain(fixtures.scorp.markers.document);
      expect(text, 'nothing on the page is a raw ISO timestamp').not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);

      const quote = await ask(page, `/quotes/${fixtures.scorp.quoteId}`);
      expect(quote.status).toBe(200);
      const deposit = quote.json.deposit as Record<string, unknown>;
      expect(deposit, 'the quote carries a deposit block').toBeTruthy();
      expect(deposit.chargeCents, 'the deposit resolved to $0').toBe(0);
      expect(deposit.treatment, 'recorded as waived').toBe('waived');

      const te = await ask(page, `/tax-engagements/${fixtures.scorp.taxEngagementId}`);
      expect(te.status, 'the return record opens').toBe(200);
      const record = te.json.taxEngagement as Record<string, unknown>;
      expect(record.return_type).toBe('1120s');
      // Delivered by the fixture (client_review), or already acknowledged if the dry run ran first (2026-09-19).
      expect(['client_review', 'completed'], 'the return is delivered or done').toContain(record.stage);
      expect(record.business_id).toBe(fixtures.scorp.businessId);

      await page.screenshot({ path: shot, fullPage: true });
      passed = true;
    } finally {
      if (!existsSync(shot)) await page.screenshot({ path: shot, fullPage: true }).catch(() => undefined);
      testInfo.annotations.push({ type: 'screenshot', description: keepScreenshot(`scorp-${viewport}`, passed, shot) });
    }
  });
});
