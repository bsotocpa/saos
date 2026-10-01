/*
 * THE LAYOUT AUDIT (Brian, 2026-09-30, R106) — every Ops and portal page at 375, 768 and 1440 in
 * Chromium and WebKit (the six layout projects in playwright.config.ts).
 *
 * Each page is opened with records at their fullest (the layoutAudit fixture: an accepted 1040 with its
 * checklist and deposit invoice, two documents, a business), allowed to settle, screenshotted whole into
 * C:\Users\brian\saos-shots\layout-r105\ (app-page-width-browser.png), and run through the layout check
 * (layout-check.ts). Every failure is appended to .artifacts/layout-failures.jsonl with the page, the
 * viewport and the browser. With LAYOUT_AUDIT=report the audit records and passes (the table Brian reads
 * before anything is fixed); otherwise a page with a failure fails its test.
 */
import { expect, test, type Page } from '@playwright/test';
import * as OTPAuth from 'otpauth';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkLayout } from './layout-check';
import { redeemPortalToken } from './portal-sign-in';

const here = dirname(fileURLToPath(import.meta.url));
interface Persona { email: string; password: string; totpSecret: string }
interface LayoutPerson { contactId: string; businessId: string; quoteId: string; taxEngagementId: string | null; portalMagicTokens: string[] }
const fixtures = JSON.parse(readFileSync(resolve(here, '..', '.artifacts', 'fixtures.json'), 'utf8')) as {
  staff: Persona;
  portalPort?: number;
  opsPort?: number;
  layoutAudit: Record<string, LayoutPerson>;
};
const OPS = `http://localhost:${fixtures.opsPort ?? 3105}`;
const PORTAL = `http://localhost:${fixtures.portalPort ?? 3106}`;
const SHOTS = process.env.LAYOUT_SHOTS ?? 'C:\\Users\\brian\\saos-shots\\layout-r105';
const LOG = resolve(here, '..', '.artifacts', 'layout-failures.jsonl');
const REPORT_ONLY = process.env.LAYOUT_AUDIT === 'report';

const OPS_PAGES = (p: LayoutPerson): Array<[string, string]> => [
  ['executive', '/'], ['account', '/account'], ['admin-automations', '/admin/automations'],
  ['admin-document-checklist', '/admin/document-checklist'], ['admin-pricing', '/admin/pricing'],
  ['admin-settings', '/admin/settings'], ['admin-staff', '/admin/staff'], ['admin-templates', '/admin/templates'],
  ['admin-wisp', '/admin/wisp'], ['alerts', '/alerts'], ['announcements', '/announcements'], ['approvals', '/approvals'],
  ['business', `/businesses/${p.businessId}`], ['clients', '/clients'], ['client', `/clients/${p.contactId}`],
  ['configurator', '/configurator'], ['documents', '/documents'], ['efile-acks', '/efile-acks'], ['events', '/events'],
  ['hilo', '/hilo'], ['inbox', '/inbox'], ['pipeline', '/pipeline'], ['queue', '/queue'], ['quote', `/quotes/${p.quoteId}`],
  ['recorder', '/recorder'], ['reports', '/reports'], ['returns-stage', '/returns?stage=scheduled'],
  ['returns-no-preparer', '/returns?preparer=none'], ['sops', '/sops'], ['tasks', '/tasks'], ['tasks-boards', '/tasks/boards'],
  ['upload-return', '/upload-return'],
];
const PORTAL_PAGES: Array<[string, string]> = [
  ['home', '/'], ['documents', '/documents'], ['returns', '/returns'], ['invoices', '/invoices'], ['messages', '/messages'],
  ['notices', '/notices'], ['profile', '/profile'], ['resources', '/resources'], ['request-service', '/request-service'],
  ['questionnaire', '/questionnaire'], ['consent', '/consent'], ['sign', '/sign'], ['estimate', '/estimate'],
];

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
/** Open a page and let it settle: the network quiet and no "Loading…" left on it. */
async function settle(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await expect(page.getByText(/^Loading…$/)).toHaveCount(0, { timeout: 15_000 }).catch(() => undefined);
  await page.waitForTimeout(300);
}

/*
 * A PAGE IS AUDITED SIGNED IN, OR NOT AT ALL (the first audit, 2026-09-30). WebKit dropped the session
 * marker between pages at some widths and the shell rendered signed out (no navigation, no Sign out):
 * those pages scored as nearly clean. "Sign out" in the header is the proof of a session; without it after
 * one reload the page is recorded as a gap in the audit, never as a pass.
 */
async function audit(page: Page, project: string, app: string, key: string, url: string, signedIn: boolean): Promise<number> {
  const [browser, width] = project.split('-');
  await settle(page, url);
  if (signedIn) {
    const signOut = page.getByTestId('sign-out');
    if (!(await signOut.isVisible().catch(() => false))) {
      await expect(signOut).toBeVisible({ timeout: 10_000 }).catch(async () => { await settle(page, url); });
    }
    if (!(await signOut.isVisible().catch(() => false))) {
      appendFileSync(LOG, JSON.stringify({ page: `${app} ${url.replace(/^https?:\/\/[^/]+/, '')}`, key: `${app}-${key}`, viewport: width, browser, check: 'audit-gap', element: 'page', detail: 'the page rendered signed out; not audited' }) + '\n');
      return 1;
    }
  }
  mkdirSync(SHOTS, { recursive: true });
  // A page taller than the browser can capture whole (32,767 px) is captured to 16,000 px, and said so.
  const shot = resolve(SHOTS, `${app}-${key}-${width}-${browser}.png`);
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  if (height > 16_000) await page.screenshot({ path: shot, fullPage: true, clip: { x: 0, y: 0, width: page.viewportSize()!.width, height: 16_000 } });
  else await page.screenshot({ path: shot, fullPage: true });
  const failures = await checkLayout(page);
  for (const f of failures) {
    appendFileSync(LOG, JSON.stringify({ page: `${app} ${new URL(page.url()).pathname}${new URL(page.url()).search}`, key: `${app}-${key}`, viewport: width, browser, ...f }) + '\n');
  }
  return failures.length;
}

test.describe('R106 layout audit', () => {
  test('every Ops page and every portal page passes the layout check', async ({ page }, testInfo) => {
    test.setTimeout(900_000);
    const project = testInfo.project.name;
    const person = fixtures.layoutAudit[project];
    expect(person, `a layout fixture for ${project}`).toBeTruthy();
    const pages: Array<{ app: string; key: string; failures: number }> = [];

    // Signed out first: the two sign-in pages.
    pages.push({ app: 'ops', key: 'login', failures: await audit(page, project, 'ops', 'login', `${OPS}/login`, false) });
    pages.push({ app: 'portal', key: 'login', failures: await audit(page, project, 'portal', 'login', `${PORTAL}/login`, false) });

    await opsSignIn(page);
    for (const [key, path] of OPS_PAGES(person!)) {
      pages.push({ app: 'ops', key, failures: await audit(page, project, 'ops', key, `${OPS}${path}`, true) });
    }

    await redeemPortalToken(page, PORTAL, person!.portalMagicTokens[0]!);
    for (const [key, path] of PORTAL_PAGES) {
      pages.push({ app: 'portal', key, failures: await audit(page, project, 'portal', key, `${PORTAL}${path}`, true) });
    }

    const failing = pages.filter((p) => p.failures > 0);
    testInfo.annotations.push({ type: 'layout', description: `${pages.length} pages, ${failing.length} with failures, ${failing.reduce((n, p) => n + p.failures, 0)} failures` });
    if (!REPORT_ONLY) expect(failing.map((p) => `${p.app}-${p.key} (${p.failures})`), 'pages failing the layout check').toEqual([]);
  });
});
