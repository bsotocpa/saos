/*
 * BATCH 10 (Brian, 2026-09-29) — at 390 × 844 and 1280 × 800, as the CEO fixture.
 *
 *   B7e (R91)  a return from a quote accepted before checklists existed: its Ops row offers "Add the
 *              document checklist"; the press builds the checklist from the quoted lines, the row reads
 *              the counts, and the door is gone.
 *   W1  (R93)  a return 20 days past its original deadline, no extension, not filed: the Ops row and
 *              the queue read "Overdue since <date>", and so does the client's portal card, never a
 *              bare past date.
 *   W2  (R93)  Record extension on the row: the overdue reading clears on the row, the queue and the
 *              portal card.
 *   X1  (R92)  the CEO merges a duplicate pair through the pair door (the record with the portal
 *              sign-in survives by rule); the retired record's page opens the survivor's, and the
 *              retired record has left search.
 */
import { expect, test, type Page } from '@playwright/test';
import * as OTPAuth from 'otpauth';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
interface Persona { email: string; password: string; totpSecret: string }
interface Batch10Person {
  backfill: { contactId: string; fullName: string; taxEngagementId: string };
  overdue: { contactId: string; fullName: string; taxEngagementId: string; engagementId: string; overdueSince: string; portalMagicTokens: string[] };
  merge: { lastName: string; withPortal: string; withoutPortal: string };
}
const fixtures = JSON.parse(readFileSync(resolve(here, '..', '.artifacts', 'fixtures.json'), 'utf8')) as {
  staff: Persona; portalPort?: number; batch10: { phone: Batch10Person; desk: Batch10Person };
};
const PORTAL = `http://localhost:${fixtures.portalPort ?? 3106}`;
const ROLES = 'ceo (engagements.tax.manage); the client';
const OVERDUE = /^Overdue since [A-Z][a-z]{2} \d{1,2}, \d{4}$/;

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

test('B7e and W1–W2: the checklist backfill on a pre-checklist return; a past deadline reads "Overdue since" until an extension is recorded', async ({ page, context }, testInfo) => {
  const viewport = testInfo.project.name;
  const who = viewport === 'desk' ? fixtures.batch10.desk : fixtures.batch10.phone;
  await signIn(page, fixtures.staff);

  // ── B7e (R91) ──
  await page.goto(`/clients/${who.backfill.contactId}`);
  const backfill = page.getByTestId(`checklist-backfill-${who.backfill.taxEngagementId}`);
  await expect(backfill, 'the door is on the row of a pre-checklist return').toBeVisible();
  await expect(page.getByTestId(`return-docs-${who.backfill.taxEngagementId}`), 'no checklist yet').toHaveCount(0);
  await backfill.click();
  await expect(page.getByTestId(`return-docs-${who.backfill.taxEngagementId}`)).toHaveText(/^Documents: 0 received · [1-9]\d* missing$/);
  await expect(backfill, 'the door closes once used').toHaveCount(0);
  testInfo.annotations.push({ type: 'walk-step', description: `B7e|/clients/:id Returns card, button "Add the document checklist" on a return from a quote accepted before checklists existed → the row reads "Documents: 0 received · n missing" and the button is gone|${ROLES}|tap` });

  // ── W1 (R93): the Ops row and the queue ──
  await page.goto(`/clients/${who.overdue.contactId}`);
  const rowOverdue = page.getByTestId(`return-overdue-${who.overdue.taxEngagementId}`);
  await expect(rowOverdue).toHaveText(OVERDUE);
  await page.goto('/queue');
  const qRow = page.locator('section.card', { has: page.getByText(who.overdue.fullName, { exact: true }) }).first();
  await expect(qRow.getByTestId('queue-overdue')).toHaveText(OVERDUE);
  await expect(qRow, 'never a bare past date').not.toContainText('Due ');
  // The client's portal card.
  const portal = await context.newPage();
  await portal.goto(`${PORTAL}/login`);
  const status = await portal.evaluate(async (t) => {
    const r = await fetch('/api/portal/auth/magic/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: t }) });
    localStorage.setItem('saos_portal_authed', '1');
    return r.status;
  }, who.overdue.portalMagicTokens[0]!);
  expect(status, 'the client redeems the sign-in link they were emailed').toBe(200);
  await portal.goto(`${PORTAL}/`);
  const card = portal.locator('section#services');
  await expect(card.getByTestId('service-overdue')).toHaveText(/^ · Overdue since [A-Z][a-z]{2} \d{1,2}, \d{4}$/);
  await expect(card, 'never a bare past date').not.toContainText('Deadline');
  testInfo.annotations.push({ type: 'walk-step', description: `W1|/clients/:id Returns card row, /queue row, and portal / (Home) services card for a return 20 days past its original deadline with no extension: each reads "Overdue since <date>", with no "Due" or "Deadline" date|${ROLES}|tap` });

  // ── W2 (R93): Record extension clears it ──
  await page.goto(`/clients/${who.overdue.contactId}`);
  const card2 = page.locator('section.card', { has: page.getByRole('heading', { name: 'Returns' }) });
  const details = card2.getByTestId('return-details');
  if (await details.count()) {
    const summary = details.locator('summary');
    if (await summary.count()) await summary.first().click();
  }
  await card2.getByTestId('record-extension').first().click();
  const dialog = page.locator('[role=dialog]');
  await expect(dialog).toBeVisible();
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
  await dialog.getByLabel('Date filed').fill(today);
  await dialog.getByRole('button', { name: 'Record extension' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId(`return-overdue-${who.overdue.taxEngagementId}`), 'the row clears').toHaveCount(0);
  await page.goto('/queue');
  await expect(page.locator('section.card', { has: page.getByText(who.overdue.fullName, { exact: true }) }).first().getByTestId('queue-overdue'), 'the queue clears').toHaveCount(0);
  await portal.goto(`${PORTAL}/`);
  await expect(portal.locator('section#services').getByTestId('service-overdue'), 'the portal card clears').toHaveCount(0);
  testInfo.annotations.push({ type: 'walk-step', description: `W2|/clients/:id Returns card, button "Record extension" (modal: "Date filed" today) → the row, the /queue row and the portal card no longer read "Overdue since"|${ROLES}|tap` });
});

test('X1: the pair door merges a duplicate; the retired record redirects to the survivor and leaves search', async ({ page }, testInfo) => {
  const viewport = testInfo.project.name;
  const who = viewport === 'desk' ? fixtures.batch10.desk : fixtures.batch10.phone;
  await signIn(page, fixtures.staff);
  const merged = await page.evaluate(async (m) => {
    const r = await fetch('/api/contacts/merge-pair', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ aId: m.withoutPortal, bId: m.withPortal, reason: 'Harness: the duplicate review marked this synthetic pair merge.' }),
    });
    return { status: r.status, body: await r.json() };
  }, who.merge);
  expect(merged.status, JSON.stringify(merged.body)).toBe(200);
  expect(merged.body.survivorId, 'the record with the portal sign-in survives').toBe(who.merge.withPortal);
  expect(merged.body.survivorRule).toBe('portal_user');
  // The retired record's page opens the survivor's: nothing pointing at it breaks.
  await page.goto(`/clients/${who.merge.withoutPortal}`);
  await page.waitForURL(new RegExp(`/clients/${who.merge.withPortal}`));
  await expect(page.getByRole('heading', { level: 1 })).toContainText(who.merge.lastName);
  // And it has left search.
  const ids = await page.evaluate(async (last) => {
    const r = await fetch(`/api/contacts?search=${encodeURIComponent(last)}&limit=10`);
    return ((await r.json()).contacts as Array<{ id: string }>).map((c) => c.id);
  }, who.merge.lastName);
  expect(ids).toEqual([who.merge.withPortal]);
  testInfo.annotations.push({ type: 'walk-step', description: `X1|POST /contacts/merge-pair as the CEO (the pair door; survivor by rule: the portal sign-in) → /clients/<retired id> in the address bar lands on the survivor's page; GET /contacts?search= returns the survivor alone|ceo (contacts.merge)|tap` });
});
