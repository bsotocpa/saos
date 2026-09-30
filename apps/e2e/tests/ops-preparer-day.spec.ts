/*
 * THE PREPARER'S DAY (R64, 2026-09-26) — path T, at 390 × 844 and 1280 × 800.
 *
 * Ana-Maria's first day in Ops, as the tax_preparer fixture: she signs in, lands on My Queue (not
 * the Executive view, which her role cannot open and which used to hang on "Loading…"), sees only
 * the pages her permissions open, opens the return assigned to her from the queue and works it end
 * to end through every door she holds, and reads a client page where every card either renders or
 * says "Not available to your role" — none swallows a refusal into "(0)".
 *
 *   T1  the home: / sends her to /queue; the queue reads her own returns.
 *   T2  the navigation: the item count and names equal the tax_preparer row of the R42 record
 *       (tasks/reports/<date>-nav-items-by-role.md, written by scripts/nav-items-by-role.mjs).
 *   T3  the return, end to end from the queue's "Client packet": Lock estimate, the stages to
 *       Internal review, Deliver Return, Record 8879 sent, the signed 8879 upload, Set final fee,
 *       Ready to file, Mark filed with Filed on, then the ATX acknowledgment upload and release
 *       (efile.manage — she holds it), which completes the return.
 *   T4  the cards: Invoices and the next session are billing.manage and bookkeeping.assigned.manage,
 *       which she does not hold — each reads the sentence and no count; the cards she can read render.
 *
 * SETUP THROUGH THE DOORS SHE DOES NOT HOLD: the contact and the business are created by the CEO
 * (contacts.write); the return record is opened by the CEO with her as preparer and the signed
 * engagement letter is filed against it. Everything from there is her own tap. Each viewport opens
 * its own return: the two projects run sequentially against ONE harness database and a return the
 * phone files has nothing left for the desk to file.
 */
import { expect, test, type Page } from '@playwright/test';
import * as OTPAuth from 'otpauth';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..');
interface Persona { email: string; password: string; totpSecret: string }
const fixtures = JSON.parse(readFileSync(resolve(here, '..', '.artifacts', 'fixtures.json'), 'utf8')) as {
  port: number;
  staff: Persona;
  scorp: { taxYear: number; preparer: { id: string; name: string } };
  wall: { anamaria: Persona };
};
const API = `http://127.0.0.1:${fixtures.port}`;
/*
 * THE CALENDAR DAY, READ WHEN IT IS NEEDED. A constant computed once at file load compared a control
 * that opened on 2026-09-27 with a 2026-09-26 the file had read at 23:57: the phone half ran before
 * midnight Chicago and the desk half after (run 2, 2026-09-26). Each test reads its own day; each
 * "opens on today" check reads the day at the moment it looks.
 */
const chicagoToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
const ROLES = 'tax_preparer (engagements.read, engagements.tax.manage, documents.write, efile.manage)';
const PDF = (name: string, body: string) => ({ name, mimeType: 'application/pdf', buffer: Buffer.from(`%PDF-1.4 ${body}\n%%EOF`) });

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
/** A staff bearer token straight from the harness API, for the setup that is not hers to tap. */
async function staffToken(who: Persona): Promise<string> {
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
/** The signed paper engagement letter into Signed Authorizations against the return — the row's own multipart door. */
async function uploadLetter(token: string, contactId: string, te: string, filename: string, day: string): Promise<void> {
  const fd = new FormData();
  for (const [k, v] of Object.entries({ contactId, category: 'signed_authorizations', taxEngagementId: te, engagementLetterSignedOn: day })) fd.append(k, v);
  const pdf = PDF(filename, 'synthetic engagement letter');
  fd.append('file', new Blob([pdf.buffer], { type: pdf.mimeType }), filename);
  const r = await fetch(`${API}/documents`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: fd });
  expect(r.status, `upload ${filename}: ${await r.text()}`).toBeLessThan(300);
}
/** A read of the API from the signed-in session, for the state the screen does not print. */
async function read(page: Page, path: string): Promise<Record<string, unknown>> {
  return page.evaluate(async (p) => (await fetch(`/api${p}`)).json().catch(() => ({})), path);
}
/** The tax_preparer row of the newest R42 navigation record, as the script wrote it. */
function recordedNav(role: string): { count: number; names: string[] } {
  const dir = resolve(root, 'tasks', 'reports');
  const file = readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}-nav-items-by-role\.md$/.test(f)).sort().pop();
  expect(file, 'tasks/reports has a nav-items-by-role record').toBeTruthy();
  const row = readFileSync(resolve(dir, file!), 'utf8').split(/\r?\n/).find((l) => l.startsWith(`| ${role} |`));
  expect(row, `the record has a ${role} row`).toBeTruthy();
  const [, , count, names] = row!.split('|').map((c) => c.trim());
  return { count: Number(count), names: names!.split(',').map((n) => n.trim()) };
}
function keepScreenshot(name: string, passed: boolean, file: string): string {
  const today = chicagoToday();
  const dir = passed ? resolve(here, '..', '.artifacts', today) : resolve(root, 'tasks', 'walks', today);
  mkdirSync(dir, { recursive: true });
  const target = resolve(dir, `${name}.png`);
  if (existsSync(file)) copyFileSync(file, target);
  return target;
}

test.describe('Ops → the preparer\'s day', () => {
  test('T1–T4: home is the queue, the navigation is hers, the assigned return worked end to end, the cards say what she cannot read', async ({ page }, testInfo) => {
    const viewport = testInfo.project.name;
    const side = viewport === 'desk' ? 'Desk' : 'Phone';
    const shot = testInfo.outputPath(`preparer-day-${viewport}.png`);
    const steps: string[] = [];
    const day = chicagoToday();
    let passed = false;
    try {
      // ── SETUP, by the CEO: the client, the business, the return with her as preparer, the letter.
      const ceo = await staffToken(fixtures.staff);
      const email = `preparer-day-${viewport}@example.test`;
      const contact = await asStaff<{ id: string }>(ceo, '/contacts', { method: 'POST', body: JSON.stringify({ firstName: 'Synthetic', lastName: `Preparerday${side}`, email }) });
      const ein = viewport === 'desk' ? '55-5555578' : '55-5555577';
      const entityName = `Harness Preparer ${side} Corp, LLC`;
      const biz = await asStaff<{ id: string }>(ceo, `/contacts/${contact.id}/businesses`, { method: 'POST', body: JSON.stringify({ name: entityName, ein, entityType: 's_corp', state: 'IL' }) });
      const ret = await asStaff<{ id: string }>(ceo, '/tax-engagements', {
        method: 'POST',
        body: JSON.stringify({
          contactId: contact.id, businessId: biz.id, taxYear: fixtures.scorp.taxYear, returnType: '1120s', clientType: 'business',
          preparerId: fixtures.scorp.preparer.id,
          reason: 'Harness walk: a return opened by hand for the preparer to work end to end; no quote stands behind it.',
        }),
      });
      const te = ret.id;
      await uploadLetter(ceo, contact.id, te, `HARNESS-PREPARER-DAY-LETTER-${viewport}.pdf`, day);

      // ── T1. HER HOME IS THE QUEUE. The root sends her there before the Executive view can hang.
      await signIn(page, fixtures.wall.anamaria);
      await page.goto('/');
      await page.waitForURL(/\/queue$/);
      await expect(page.getByRole('heading', { name: 'My Queue', exact: true })).toBeVisible();
      await expect(page.getByText('You see only the returns assigned to you.')).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Executive' }), 'the Executive view never renders for her').toHaveCount(0);
      await expect(page.getByText('Loading…'), 'nothing is left loading').toHaveCount(0);
      const me = await read(page, '/auth/me');
      expect(me.home, 'the API names the queue as her home').toBe('/queue');
      steps.push(`T1|/ → /queue by the shell from GET /auth/me home; heading "My Queue", "You see only the returns assigned to you."|${ROLES}|tap`);

      // ── T2. THE NAVIGATION IS HERS: the count and the names equal the R42 record's tax_preparer row.
      const recorded = recordedNav('tax_preparer');
      const nav = page.getByTestId('top-nav');
      await expect(nav).toHaveAttribute('data-ready', 'yes');
      await expect(nav.locator('a')).toHaveCount(recorded.count);
      expect(await nav.locator('a').allInnerTexts(), 'the items, in the table\'s order').toEqual(recorded.names);
      for (const absent of ['Executive', 'Staff', 'Automations', 'Pricing', 'Settings']) {
        await expect(nav.getByRole('link', { name: absent, exact: true }), `${absent} is not in her navigation`).toHaveCount(0);
      }
      steps.push(`T2|nav[data-testid=top-nav]: ${recorded.count} items, the tax_preparer row of tasks/reports/*-nav-items-by-role.md|${ROLES}|tap`);

      // ── T3. THE RETURN, from the queue's row to filed and acknowledged.
      const queueRow = page.locator('section.card', { has: page.getByText(`Synthetic Preparerday${side}`) });
      await expect(queueRow, 'the return assigned to her is in her queue').toBeVisible();
      await expect(queueRow.getByText(`${fixtures.scorp.taxYear} 1120S`)).toBeVisible();
      await queueRow.getByRole('link', { name: 'Client packet' }).click();
      await page.waitForURL(new RegExp(`/clients/${contact.id}$`));
      const card = page.locator('section.card', { has: page.getByRole('heading', { name: 'Returns' }) });
      const dialog = page.locator('[role=dialog]');
      await expect(card.getByText(`Preparer: ${fixtures.scorp.preparer.name}`), 'the row already names her').toBeVisible();

      await card.getByRole('button', { name: 'Lock estimate' }).click();
      await expect(dialog.getByText(/no quoted range on file/), 'a hand-opened return has no quote to read the range from').toBeVisible();
      await dialog.getByLabel('Low end (dollars)').fill('600');
      await dialog.getByLabel('High end (dollars)').fill('800');
      await dialog.getByRole('button', { name: 'Lock estimate' }).click();
      await expect(dialog).toHaveCount(0);
      await expect(card.getByText(/Estimate locked/)).toBeVisible();
      for (const label of ['Schedule', 'Request documents', 'Start preparation', 'Internal review']) {
        await card.getByRole('button', { name: label, exact: true }).click();
        await dialog.getByRole('button', { name: label, exact: true }).click();
        await expect(dialog, `${label} is confirmed in its own modal`).toHaveCount(0);
        await page.waitForTimeout(400);
      }
      expect(((await read(page, `/tax-engagements/${te}`)).taxEngagement as { stage: string }).stage).toBe('internal_review');

      await page.goto('/upload-return');
      await expect(page.getByRole('heading', { name: 'Deliver a return' })).toBeVisible();
      await page.getByLabel('Find the client').fill(email);
      await page.getByLabel('Find the client').press('Enter');
      await page.locator('button.btn.ghost', { hasText: email }).click();
      await expect(page.getByLabel('Tax engagement')).toHaveValue(te);
      await page.locator('input[type=file]').setInputFiles(PDF(`HARNESS-PREPARER-DAY-1120S-${viewport}.pdf`, 'synthetic 1120S return'));
      await expect(page.getByTestId('delivery-result')).toContainText('The stage moved to Client Review.');

      await page.goto(`/clients/${contact.id}`);
      await page.getByTestId('record-8879-sent').click();
      await dialog.getByTestId('sent-8879-method').locator('select').selectOption('in_office');
      await expect(dialog.getByLabel('Date sent')).toHaveValue(chicagoToday());
      await dialog.getByRole('button', { name: 'Record 8879 sent' }).click();
      await expect(dialog).toHaveCount(0);
      const uploadBtn = page.getByTestId('upload-signed-8879');
      await expect(uploadBtn).toBeVisible();
      await page.locator('input[type=file]').setInputFiles(PDF(`HARNESS-PREPARER-DAY-8879-${viewport}.pdf`, 'synthetic signed 8879-CORP'));
      await page.getByLabel('Signed on').fill(chicagoToday());
      await page.getByLabel('PTIN holder').selectOption(fixtures.scorp.preparer.id);
      await uploadBtn.click();
      await expect(uploadBtn, 'the upload is the authorization; the control leaves once it is on file').toHaveCount(0);

      await page.getByRole('button', { name: 'Set final fee' }).click();
      await dialog.getByLabel(/Final fee/).fill('700.00');
      await dialog.getByRole('button', { name: 'Set final fee' }).click();
      await expect(dialog).toHaveCount(0);
      await page.getByRole('button', { name: 'Ready to file' }).click();
      await dialog.getByRole('button', { name: 'Ready to file' }).click();
      await expect(dialog).toHaveCount(0);
      await page.getByRole('button', { name: 'Mark filed' }).click();
      await expect(dialog.getByLabel('Filed on'), 'the filed day opens on today').toHaveValue(chicagoToday());
      await expect(dialog.getByLabel(/PTIN holder/)).toHaveValue(fixtures.scorp.preparer.id);
      await dialog.getByRole('button', { name: 'Mark filed' }).click();
      await expect(dialog).toHaveCount(0);
      const filed = (await read(page, `/tax-engagements/${te}`)).taxEngagement as { stage: string; filed_date: string };
      expect(filed.stage).toBe('filed');
      expect([day, chicagoToday()], 'filed on the day it was tapped').toContain(filed.filed_date);

      // The acknowledgment, hers too (efile.manage): the committed fixture plus this entity's two rows.
      const fixture = readFileSync(resolve(root, 'apps', 'api', 'test', 'fixtures', 'atx', 'ATX_EFiles_synthetic.csv'), 'utf8').replace(/\s+$/, '');
      const ackDay = chicagoToday();
      const atxDate = `${Number(ackDay.slice(5, 7))}/${Number(ackDay.slice(8, 10))}/${ackDay.slice(0, 4)}`;
      const exportName = entityName.toUpperCase().replace(/[.,]/g, '');
      const last4 = ein.slice(-4);
      const report = [
        fixture,
        `${exportName},,,90000${last4},pdfed${last4}${viewport}x9k2m4n7,Federal,1120S,Federal,Accepted,${atxDate} 6:41:08 PM,TBD,0,Zero Balance,,0,Ogden`,
        `${exportName},,,90000${last4},pdil${last4}${viewport}x9k2m4n7q,IL,IL 1120-ST,Return,Accepted,${atxDate} 7:02:30 PM,TBD,0,Zero Balance,,0,Illinois`,
      ].join('\n');
      await page.goto('/efile-acks');
      await expect(page.getByRole('heading', { name: 'E-file acknowledgments' })).toBeVisible();
      await page.locator('input[type=file]').setInputFiles({ name: 'E-Files.csv', mimeType: 'text/csv', buffer: Buffer.from(report, 'utf8') });
      await expect(page.getByRole('status')).toContainText('2 will send');
      await page.getByRole('button', { name: /^Release/ }).first().click();
      await page.locator('[role=dialog]').getByRole('button', { name: /^Release 2/ }).click();
      await expect(page.getByRole('status')).toContainText('Released: 2 queued to send');
      const acked = (await read(page, `/tax-engagements/${te}`)).taxEngagement as { stage: string; state_accepted_code: string | null };
      expect(acked.stage, 'federal and Illinois both accepted complete the return').toBe('completed');
      expect(acked.state_accepted_code).toBe('IL');
      steps.push(`T3|/queue row "Client packet" → /clients/:id Returns card: "Lock estimate" (Low end, High end), "Schedule", "Request documents", "Start preparation", "Internal review"; /upload-return (Find the client, input[type=file]); "Record 8879 sent" (Method, Date sent); input[type=file] + "Signed on" + "PTIN holder" + "Upload the signed 8879"; "Set final fee"; "Ready to file"; "Mark filed" (Filed on today, PTIN holder); /efile-acks input[type=file] + "Release 2" → the return reads completed|${ROLES}|tap`);

      // ── T4. THE CARDS: what she cannot read says so; what she can read renders.
      await page.goto(`/clients/${contact.id}`);
      await expect(page.getByRole('heading', { name: /^Documents \(\d+\)$/ })).toBeVisible();
      await page.waitForTimeout(800);
      const invoices = page.locator('section.card', { has: page.getByRole('heading', { name: /^Invoices/ }) });
      await expect(invoices.getByRole('heading'), 'the Invoices heading carries no count she was refused').toHaveText('Invoices');
      await expect(invoices.getByTestId('role-unavailable')).toHaveText('Not available to your role');
      const meetings = page.locator('section.card', { has: page.getByRole('heading', { name: 'Meetings', exact: true }) });
      await expect(meetings.locator('[data-testid=role-unavailable][data-card=next-session]')).toHaveText('Not available to your role');
      await expect(meetings.getByRole('heading', { name: /^Recorded \(\d+\)$/ }), 'the sessions she can read keep their count').toBeVisible();
      for (const heading of ['Returns', 'Quotes', 'Engagement packet']) {
        const sec = page.locator('section.card', { has: page.getByRole('heading', { name: heading, exact: true }) });
        await expect(sec, `the ${heading} card renders`).toBeVisible();
        await expect(sec.getByTestId('role-unavailable'), `${heading} is hers to read`).toHaveCount(0);
      }
      await expect(card.getByText(`${fixtures.scorp.taxYear} 1120S`)).toBeVisible();
      await expect(page.getByText('No quotes sent.')).toBeVisible();
      const refusedCards = page.getByTestId('role-unavailable');
      await expect(refusedCards, 'exactly the two doors she does not hold').toHaveCount(2);
      // A refused card's own heading carries no count: "Invoices", "Meetings" — never "(0)" for a list she was refused.
      // (A count she CAN read stays, "Recorded (0)" under Meetings included: that zero is true.)
      for (const sec of await page.locator('section.card', { has: refusedCards }).all()) {
        expect(await sec.locator('h2').first().innerText(), 'the heading of a refused card never reads (0)').not.toMatch(/\(0\)/);
      }
      const text = await page.evaluate(() => document.body.innerText);
      expect(text, 'no "Invoices (0)" anywhere on her page').not.toContain('Invoices (0)');
      steps.push(`T4|/clients/:id: Invoices reads "Not available to your role" with no count (billing.manage); Meetings "Next session: Not available to your role" (bookkeeping.assigned.manage); Returns, Documents (n), Quotes, Engagement packet, Recorded (n) render|${ROLES}|tap`);

      await page.screenshot({ path: shot, fullPage: true });
      passed = true;
    } finally {
      if (!existsSync(shot)) await page.screenshot({ path: shot, fullPage: true }).catch(() => undefined);
      testInfo.annotations.push({ type: 'screenshot', description: keepScreenshot(`preparer-day-${viewport}`, passed, shot) });
      for (const s of steps) testInfo.annotations.push({ type: 'walk-step', description: s });
    }
  });
});
