/*
 * THE BUSINESS PAGE, FOR BRIAN'S APPROVAL (2026-09-26, R40). Two businesses at two widths — 390 and
 * 1280 — saved as full-page PNGs under C:\Users\brian\saos-shots\business-page\<state>-<width>.png:
 *
 *   with-engagements  a synthetic S corporation with an active bookkeeping engagement, an 1120-S driven
 *                     through the API doors to filed (letter, estimate, the stages, 8879 sent and on
 *                     file, the final fee, filed federal + IL), so the Invoices card carries the
 *                     final-fee invoice, and a bank statement filed to the business
 *   empty             a business created through the Add a business door and nothing else
 *
 * NOT the S corp fixture: ops-scorp-dry-run.spec.ts asserts that fixture's owner has exactly one return
 * record (the one the accepted quote creates), and this spec runs before it in the full harness, so the
 * pictures come from businesses of their own. Service facts on the pictured business read their empty
 * sentences: the 0105–0111 facts have no Ops door yet (the Trello importer writes them), which is what
 * a business that was never imported truthfully shows.
 *
 * One project sets the two widths itself (the other project skips), signed in as the CEO fixture.
 */
import { expect, test, type Page } from '@playwright/test';
import * as OTPAuth from 'otpauth';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
interface Persona { email: string; password: string; totpSecret: string }
const fixtures = JSON.parse(readFileSync(resolve(here, '..', '.artifacts', 'fixtures.json'), 'utf8')) as {
  port: number;
  staff: Persona;
  scorp: { taxYear: number; preparer: { id: string; name: string } };
};
const API = `http://127.0.0.1:${fixtures.port}`;
const SHOTS = 'C:\\Users\\brian\\saos-shots\\business-page';
const WIDTHS: Array<{ width: number; height: number }> = [
  { width: 390, height: 844 },
  { width: 1280, height: 800 },
];
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
const PDF = { mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 synthetic harness document — no real client data\n%%EOF') };
const addDays = (iso: string, n: number): string => {
  const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

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
async function staffToken(who: Persona = fixtures.staff): Promise<string> {
  const totp = new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(who.totpSecret) }).generate();
  const r = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: who.email, password: who.password, totp }) });
  expect(r.status, `${who.email} signs in on the harness API`).toBe(200);
  return ((await r.json()) as { token: string }).token;
}
async function asStaff<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch(`${API}${path}`, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(init.headers ?? {}) } });
  const body = (await r.json().catch(() => ({}))) as T;
  expect(r.status, `${init.method ?? 'GET'} ${path}: ${JSON.stringify(body)}`).toBeLessThan(300);
  return body;
}
const post = (token: string, path: string, body: Record<string, unknown>) => asStaff(token, path, { method: 'POST', body: JSON.stringify(body) });
async function upload(token: string, fields: Record<string, string>, filename: string): Promise<void> {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  fd.append('file', new Blob([PDF.buffer], { type: PDF.mimeType }), filename);
  const r = await fetch(`${API}/documents`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: fd });
  const body = await r.json().catch(() => ({}));
  expect(r.status, `upload ${filename}: ${JSON.stringify(body)}`).toBeLessThan(300);
}

type State = 'with-engagements' | 'empty';
/** A synthetic owner and business through the Add a business door; the full state driven through the doors the walks tap. */
async function businessIn(token: string, state: State): Promise<{ contactId: string; businessId: string; name: string }> {
  const contact = await asStaff<{ id: string }>(token, '/contacts', {
    method: 'POST', body: JSON.stringify({ firstName: 'Synthetic', lastName: `Shots ${state}`, email: `business-shots-${state}@example.test` }),
  });
  const name = state === 'empty' ? 'Synthetic Empty Holdings LLC' : 'Synthetic Shots Corp, LLC';
  const business = await asStaff<{ id: string }>(token, `/contacts/${contact.id}/businesses`, {
    method: 'POST',
    body: JSON.stringify(state === 'empty'
      ? { name, entityType: 'llc', state: 'IL' }
      : { name, ein: '88-8888801', entityType: 's_corp', state: 'IL', industry: 'food_beverage', formationDate: '2019-06-03', makePrimary: true }),
  });
  if (state === 'empty') return { contactId: contact.id, businessId: business.id, name };

  await post(token, '/engagements', { contactId: contact.id, businessId: business.id, serviceLine: 'bookkeeping', status: 'active', title: 'Monthly bookkeeping', reason: 'Harness screenshots: an engagement opened by hand so the business page can be photographed with one.' });
  const ret = await asStaff<{ id: string }>(token, '/tax-engagements', {
    method: 'POST',
    body: JSON.stringify({
      contactId: contact.id, businessId: business.id, taxYear: fixtures.scorp.taxYear, returnType: '1120s', clientType: 'business', preparerId: fixtures.scorp.preparer.id,
      reason: 'Harness screenshots: a return opened by hand so the business page can be photographed with one; no quote stands behind it.',
    }),
  });
  const te = ret.id;
  await upload(token, { contactId: contact.id, category: 'signed_authorizations', taxEngagementId: te, engagementLetterSignedOn: addDays(today, -12) }, 'HARNESS-BIZPAGE-LETTER.pdf');
  await post(token, `/tax-engagements/${te}/estimate`, { minCents: 60000, maxCents: 80000 });
  for (const toStage of ['scheduled', 'documents_requested', 'in_preparation', 'internal_review', 'client_review']) await post(token, `/tax-engagements/${te}/transition`, { toStage });
  await post(token, `/tax-engagements/${te}/8879-sent`, { method: 'in_office', sentOn: addDays(today, -4) });
  await upload(token, { contactId: contact.id, category: 'signed_authorizations', taxEngagementId: te, signedOn: addDays(today, -3), preparerPtinHolderId: fixtures.scorp.preparer.id }, 'HARNESS-BIZPAGE-8879.pdf');
  await post(token, `/tax-engagements/${te}/final-fee`, { finalFeeCents: 70000 });
  await post(token, `/tax-engagements/${te}/transition`, { toStage: 'ready_to_file' });
  await post(token, `/tax-engagements/${te}/transition`, { toStage: 'filed', preparerPtinHolderId: fixtures.scorp.preparer.id, jurisdictions: ['federal', 'IL'], filedOn: addDays(today, -2) });
  // A document filed TO THE BUSINESS (the letter and the 8879 are filed to the return).
  await upload(token, { contactId: contact.id, businessId: business.id, category: 'business_records' }, 'HARNESS-BIZPAGE-BANK-STATEMENT.pdf');
  return { contactId: contact.id, businessId: business.id, name };
}

test('the business page, with engagements and empty, at 390 and 1280', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desk', 'one project sets the two widths itself');
  test.setTimeout(600_000);
  mkdirSync(SHOTS, { recursive: true });
  const token = await staffToken();
  const states: State[] = ['with-engagements', 'empty'];
  const made = new Map<State, { contactId: string; businessId: string; name: string }>();
  for (const s of states) made.set(s, await businessIn(token, s));

  await signIn(page, fixtures.staff);
  const saved: string[] = [];
  for (const size of WIDTHS) {
    await page.setViewportSize(size);
    for (const state of states) {
      const { contactId, businessId, name } = made.get(state)!;
      await page.goto(`/businesses/${businessId}`);
      await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
      await expect(page.getByTestId('business-owner-line').getByRole('link')).toHaveAttribute('href', `/clients/${contactId}`);
      await expect(page.getByTestId('role-unavailable'), 'the CEO is refused nothing').toHaveCount(0);
      const width = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
      expect(width.scroll, `no page-level horizontal scroll at ${size.width} (${state})`).toBeLessThanOrEqual(width.client);

      if (state === 'with-engagements') {
        await expect(page.getByTestId('card-engagements').getByRole('heading', { level: 2 })).toHaveText('Engagements (2)');
        await expect(page.getByTestId('card-engagements')).toContainText('Monthly bookkeeping');
        await expect(page.getByTestId('card-returns').getByRole('heading', { level: 2 })).toHaveText('Returns (1)');
        await expect(page.getByTestId('card-returns')).toContainText(`${fixtures.scorp.taxYear} 1120S`);
        await expect(page.getByTestId('card-returns')).toContainText(`preparer of record: ${fixtures.scorp.preparer.name}`);
        await expect(page.getByTestId('card-returns')).toContainText('Final fee $700.00');
        await expect(page.getByTestId('card-invoices').getByRole('heading', { level: 2 })).toHaveText('Invoices (1)');
        await expect(page.getByTestId('card-invoices')).toContainText('$700.00');
        await expect(page.getByTestId('card-documents').getByRole('heading', { level: 2 })).toHaveText('Documents (1)');
        await expect(page.getByTestId('card-documents')).toContainText('HARNESS-BIZPAGE-BANK-STATEMENT.pdf');
        await expect(page.getByTestId('entity-ein')).toHaveText('EIN 88-8888801');
        await expect(page.getByTestId('card-entity')).toContainText('Jun 3, 2019');
        await expect(page.getByTestId('fact-books')).toHaveText('not recorded');
        await expect(page.getByTestId('fact-sales-tax'), 'R40 wording').toHaveText('no sales-tax engagement on file');
        await expect(page.getByTestId('fact-payroll'), 'R40 wording').toHaveText('no payroll engagement on file');
      }
      if (state === 'empty') {
        await expect(page.getByTestId('entity-ein')).toHaveText('no EIN on file');
        await expect(page.getByTestId('card-engagements').getByRole('heading', { level: 2 })).toHaveText('Engagements (0)');
        await expect(page.getByTestId('card-engagements')).toContainText('No engagement names this business.');
        await expect(page.getByTestId('card-returns')).toContainText('No tax return names this business.');
        await expect(page.getByTestId('card-invoices')).toContainText('No invoice is attributed to this business');
        await expect(page.getByTestId('card-documents')).toContainText('No document is filed to this business.');
        await expect(page.getByTestId('fact-annual-report')).toHaveText('no compliance record');
        await expect(page.getByTestId('fact-qbo')).toHaveText('unknown');
      }
      const path = resolve(SHOTS, `${state}-${size.width}.png`);
      await page.screenshot({ path, fullPage: true });
      saved.push(path);
    }
  }
  for (const p of saved) testInfo.annotations.push({ type: 'screenshot', description: p });
  expect(saved.length, 'four pictures').toBe(4);
});
