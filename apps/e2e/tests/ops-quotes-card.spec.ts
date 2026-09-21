/*
 * THE QUOTES CARD ON THE CLIENT PAGE (Brian, 2026-09-20) — path Q, at 390 × 844 and 1280 × 800.
 *
 * Each row on the card reads who and which business the quote is for, its lines by price-book code,
 * its state, when it was sent and when it expires. Its four controls, for quotes.manage:
 *
 *   Q1  Open — the Ops quote page, which nothing in Ops could reach before (the send confirmation
 *       had been telling staff to "open the client and edit or resend this one" since M27).
 *   Q2  Copy client link — the link the client was emailed, read back from the stored token (0117),
 *       the confirmation line, and the link opens the proposal with no session.
 *   Q3  Resend proposal email — the one send site again: a new link reaches the mailer, the earlier
 *       one stops working, the confirmation line says so.
 *   Q4  Withdraw — a draft, with a reason typed in the modal; the row reads Withdrawn.
 *
 * The subject is this spec's own: a synthetic person, a business, a sent quote and a draft per
 * viewport, because the two projects run sequentially against one harness database and Q3 and Q4
 * each change the row they tap. The role proof is Jaqueline (ed_coo), who reads the card through
 * engagements.read and holds no quotes.manage: the rows, no control on them, every route refuses her.
 */
import { expect, test, type Page } from '@playwright/test';
import * as OTPAuth from 'otpauth';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..');
interface Persona { email: string; password: string; totpSecret: string }
const fixtures = JSON.parse(readFileSync(resolve(here, '..', '.artifacts', 'fixtures.json'), 'utf8')) as {
  port: number;
  staff: Persona;
  scorp: { itemCode: string };
  wall: { jaqueline: Persona };
};
const API = `http://localhost:${fixtures.port}`;
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
const ROLES = 'tax_preparer, ceo (quotes.manage)';
const CONTROL = {
  open: '/clients/:id Quotes card, link "Open" → /quotes/:id',
  copy: '/clients/:id Quotes card, button "Copy client link" → confirmation line with the link',
  resend: '/clients/:id Quotes card, button "Resend proposal email" → ask() modal, button "Resend proposal"',
  withdraw: '/clients/:id Quotes card, button "Withdraw…" → ask() modal, textarea, button "Withdraw draft"',
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
/** A staff bearer token straight from the harness API, for the setup this spec does not tap. */
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
/** The proposal links the harness mailer has carried so far (e2e-boot serves them on the API port). */
async function quoteTokensSoFar(): Promise<string[]> {
  const r = await fetch(`${API}/harness/mail-links`);
  return ((await r.json()) as { quoteTokens: string[] }).quoteTokens;
}
/** Whether a client link opens the proposal, asked of the public route with no session. */
async function linkOpens(token: string): Promise<number> {
  return (await fetch(`${API}/public/quote/${token}`)).status;
}
function keepScreenshot(name: string, passed: boolean, file: string): string {
  const dir = passed ? resolve(here, '..', '.artifacts', today) : resolve(root, 'tasks', 'walks', today);
  mkdirSync(dir, { recursive: true });
  const target = resolve(dir, `${name}.png`);
  if (existsSync(file)) copyFileSync(file, target);
  return target;
}

/** This spec's own subject: a person, a business, a sent quote and a draft. Built through the routes, never an INSERT. */
async function subject(tag: string): Promise<{ contactId: string; fullName: string; business: string; sentId: string; draftId: string; emailedToken: string }> {
  const token = await staffToken();
  const lastName = `Quotescard-${tag}`;
  const contact = await asStaff<{ id: string }>(token, '/contacts', { method: 'POST', body: JSON.stringify({ firstName: 'Synthetic', lastName, email: `quotescard-${tag.toLowerCase()}@example.test`, language: 'en' }) });
  const business = `Harness Quotes ${tag} LLC`;
  const biz = await asStaff<{ id: string }>(token, `/contacts/${contact.id}/businesses`, { method: 'POST', body: JSON.stringify({ name: business, entityType: 's_corp', state: 'IL' }) });
  const sent = await asStaff<{ id: string }>(token, '/quotes', { method: 'POST', body: JSON.stringify({ contactId: contact.id, businessId: biz.id, lines: [{ itemCode: fixtures.scorp.itemCode }], expiresInDays: 30 }) });
  const before = (await quoteTokensSoFar()).length;
  await asStaff(token, `/quotes/${sent.id}/send`, { method: 'POST', body: '{}' });
  const after = await quoteTokensSoFar();
  expect(after.length, 'the proposal email reached the harness mailer').toBe(before + 1);
  const draft = await asStaff<{ id: string }>(token, '/quotes', { method: 'POST', body: JSON.stringify({ contactId: contact.id, businessId: biz.id, lines: [{ itemCode: fixtures.scorp.itemCode }] }) });
  return { contactId: contact.id, fullName: `Synthetic ${lastName}`, business, sentId: sent.id, draftId: draft.id, emailedToken: after[after.length - 1]! };
}

test.describe('Ops → the Quotes card', () => {
  test('Q1–Q4: the CEO opens a quote, copies its link, resends the proposal and withdraws a draft from the Quotes card', async ({ page }, testInfo) => {
    const viewport = testInfo.project.name;
    const shot = testInfo.outputPath(`quotes-card-${viewport}.png`);
    const steps: string[] = [];
    let passed = false;
    try {
      const s = await subject(viewport.charAt(0).toUpperCase() + viewport.slice(1));
      await signIn(page, fixtures.staff);
      await page.goto(`/clients/${s.contactId}`);
      const card = page.locator('section.card', { has: page.getByRole('heading', { name: 'Quotes' }) });
      await expect(card).toBeVisible();

      // ── The row: who, which business, the lines by code, the state, sent and expiry.
      const sentRow = card.getByTestId(`quote-row-${s.sentId}`);
      await expect(sentRow).toBeVisible();
      await expect(sentRow, 'the state').toContainText('Sent');
      await expect(sentRow, 'who it is for').toContainText(`for ${s.fullName}`);
      await expect(sentRow, 'which business').toContainText(s.business);
      await expect(sentRow, 'the lines in short form').toContainText(fixtures.scorp.itemCode);
      await expect(sentRow, 'when it was sent').toContainText('sent ');
      await expect(sentRow, 'when it expires').toContainText('expires ');
      const draftRow = card.getByTestId(`quote-row-${s.draftId}`);
      await expect(draftRow, 'the draft says who started it').toContainText('started by');

      // ── Q1. OPEN: the Ops quote page.
      await sentRow.getByRole('link', { name: 'Open' }).click();
      await page.waitForURL(new RegExp(`/quotes/${s.sentId}$`));
      await expect(page.getByRole('heading', { name: /^Quote/ })).toBeVisible();
      // The record's line, awaited: the page is read only once the quote has rendered, never mid-load.
      await expect(page.getByText(s.business).first(), 'the quote page names the business').toBeVisible();
      const quotePage = await page.evaluate(() => document.body.innerText);
      expect(quotePage, 'the quote page names the client').toContain(s.fullName);
      expect(quotePage, 'and the business').toContain(s.business);
      expect(quotePage, 'and the line').toContain(fixtures.scorp.itemCode);
      expect(quotePage, 'nothing on it is a raw timestamp').not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
      steps.push(`Q1|${CONTROL.open}|${ROLES}|tap`);

      // ── Q2. COPY CLIENT LINK: the confirmation line carries the link the client was emailed, and it opens the proposal.
      await page.goto(`/clients/${s.contactId}`);
      await expect(sentRow).toBeVisible();
      await sentRow.getByRole('button', { name: 'Copy client link' }).click();
      const note = sentRow.getByTestId(`quote-note-${s.sentId}`);
      await expect(note, 'the confirmation line').toContainText('the same link the client was emailed');
      const copiedUrl = (await note.locator('code').textContent())?.trim() ?? '';
      expect(copiedUrl, 'the confirmation carries the portal link').toMatch(/\/quote\/[A-Za-z0-9_-]{20,}$/);
      const copiedToken = copiedUrl.split('/').pop()!;
      expect(copiedToken, 'the copied link is the emailed href, not a new one').toBe(s.emailedToken);
      expect(await linkOpens(copiedToken), 'the copied link opens the proposal with no session').toBe(200);
      steps.push(`Q2|${CONTROL.copy}|${ROLES}|tap`);

      // ── Q3. RESEND: a new link reaches the mailer, the copied one stops working, the line says so.
      const before = (await quoteTokensSoFar()).length;
      await sentRow.getByRole('button', { name: 'Resend proposal email' }).click();
      const modal = page.locator('[role=dialog]', { hasText: 'Resend the proposal email?' });
      await expect(modal).toBeVisible();
      await modal.getByRole('button', { name: 'Resend proposal' }).click();
      await expect(modal).toHaveCount(0);
      await expect(sentRow.getByTestId(`quote-note-${s.sentId}`), 'the confirmation line').toContainText('Proposal email resent');
      const after = await quoteTokensSoFar();
      expect(after.length, 'the proposal email reached the harness mailer again').toBe(before + 1);
      expect(await linkOpens(after[after.length - 1]!), 'the resent link opens').toBe(200);
      expect(await linkOpens(copiedToken), 'the earlier link no longer works').toBe(404);
      await expect(sentRow, 'still one sent quote, not two').toContainText('Sent');
      steps.push(`Q3|${CONTROL.resend}|${ROLES}|tap`);

      // ── Q4. WITHDRAW a draft, with a reason.
      await draftRow.getByRole('button', { name: 'Withdraw…' }).click();
      const withdraw = page.locator('[role=dialog]', { hasText: 'Withdraw this draft quote?' });
      await expect(withdraw).toBeVisible();
      await expect(withdraw.getByRole('button', { name: 'Withdraw draft' }), 'no reason, no withdrawal').toBeDisabled();
      await withdraw.locator('textarea').fill(`harness walk ${viewport}: the client chose the sent proposal instead`);
      await withdraw.getByRole('button', { name: 'Withdraw draft' }).click();
      await expect(withdraw).toHaveCount(0);
      await expect(page.getByText('Draft withdrawn.')).toBeVisible();
      await expect(card.getByTestId(`quote-row-${s.draftId}`), 'the row reads Withdrawn').toContainText('Withdrawn');
      await expect(card.getByTestId(`quote-row-${s.draftId}`).getByRole('button', { name: 'Withdraw…' }), 'and offers no second withdrawal').toHaveCount(0);
      await page.screenshot({ path: shot, fullPage: true });
      steps.push(`Q4|${CONTROL.withdraw}|${ROLES}|tap`);
      passed = true;
    } finally {
      if (!existsSync(shot)) await page.screenshot({ path: shot, fullPage: true }).catch(() => undefined);
      testInfo.annotations.push({ type: 'screenshot', description: keepScreenshot(`quotes-card-${viewport}`, passed, shot) });
      for (const st of steps) testInfo.annotations.push({ type: 'walk-step', description: st });
    }
  });

  test('role proof: a reader without quotes.manage sees no control on the Quotes card and every door refuses her', async ({ page }, testInfo) => {
    const viewport = testInfo.project.name;
    const s = await subject(`Role${viewport.charAt(0).toUpperCase() + viewport.slice(1)}`);
    await signIn(page, fixtures.wall.jaqueline);
    await page.goto(`/clients/${s.contactId}`);
    const card = page.locator('section.card', { has: page.getByRole('heading', { name: 'Quotes' }) });
    await expect(card).toBeVisible();
    await expect(card.getByTestId(`quote-row-${s.sentId}`), 'she reads the row').toContainText('Sent');
    for (const name of ['Open', 'Copy client link', 'Resend proposal email', 'Withdraw…']) {
      await expect(card.getByRole('button', { name }), `no "${name}" on her card`).toHaveCount(0);
      await expect(card.getByRole('link', { name }), `no "${name}" link on her card`).toHaveCount(0);
    }
    const statuses = await page.evaluate(async ({ sentId, draftId }) => {
      const post = (path: string, body: unknown) => fetch(`/api${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.status);
      return {
        link: await post(`/quotes/${sentId}/client-link`, {}),
        resend: await post(`/quotes/${sentId}/send`, { resend: true }),
        withdraw: await post(`/quotes/${draftId}/withdraw-draft`, { reason: 'trying the withdraw door without the grant' }),
      };
    }, { sentId: s.sentId, draftId: s.draftId });
    expect(statuses, 'every door refuses a role without quotes.manage').toEqual({ link: 403, resend: 403, withdraw: 403 });
    for (const id of ['Q1', 'Q2', 'Q3', 'Q4']) {
      testInfo.annotations.push({ type: 'walk-step', description: `${id}|role proof: ed_coo (engagements.read, no quotes.manage) reads the row and sees no control; client-link, resend and withdraw-draft refused 403|${ROLES}|tap` });
    }
  });
});
