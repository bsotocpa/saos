/*
 * THE RAIL OF FIVE PHASES, FOR BRIAN'S APPROVAL (2026-09-26 R50; re-shot 2026-09-27 for R50 v2). Three
 * states of the rail at three widths — 390, 768 and 1280 — saved as full-page PNGs at full resolution
 * under C:\Users\brian\saos-shots\stepper-v2\<state>-<width>.png:
 *
 *   mid-preparation      Engage done (one line, dated by "scheduled"); Prepare open with documents
 *                        requested and in preparation done and internal review current with its
 *                        "Internal review" button; Sign, File, Close their greyed names; an extension
 *                        recorded, so the details area carries the badge
 *   filed-awaiting-acks  Engage, Prepare and Sign done (Sign dated by the 8879 on file); File open with
 *                        the fee, ready to file and filed done and the jurisdiction step current, waiting
 *                        on the acknowledgments for federal and IL; Close its greyed name
 *   completed            both jurisdictions accepted, the return completed and the invoice paid: five
 *                        done lines, nothing open, the jurisdiction record under the rail
 *
 * FULL RESOLUTION: this file runs its browser at deviceScaleFactor 2 (test.use below, over the desk
 * project's default of 1) and screenshots with scale 'device', so a 390-wide page is a 780-pixel PNG,
 * 768 → 1536 and 1280 → 2560.
 *
 * One project sets the three widths itself (the other project skips), signed in as the CEO fixture.
 * The three returns are opened once through the API doors the walks already tap (the return record,
 * the signed letter, the estimate, the stages, Record 8879 sent, the signed 8879, the fee, the filing,
 * the ATX acceptance and the Stripe event), then photographed at each width. Beside the pictures the
 * spec reads what a person would: which phase is open and which step in it is current, that it alone
 * carries a control, that a done phase is one line with its date and a future phase its name alone,
 * that a done step names its day and its person, no page-level horizontal scroll, 44px targets at 390
 * and the current phase in view at 390.
 */
import { expect, test, type Page } from '@playwright/test';
import * as OTPAuth from 'otpauth';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

test.use({ deviceScaleFactor: 2 });

const here = dirname(fileURLToPath(import.meta.url));
interface Persona { email: string; password: string; totpSecret: string }
const fixtures = JSON.parse(readFileSync(resolve(here, '..', '.artifacts', 'fixtures.json'), 'utf8')) as {
  port: number;
  staff: Persona;
  scorp: { taxYear: number; preparer: { id: string; name: string }; webhookSecret: string };
};
const API = `http://127.0.0.1:${fixtures.port}`;
const SHOTS = 'C:\\Users\\brian\\saos-shots\\stepper-v2';
const WIDTHS: Array<{ width: number; height: number }> = [
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 1280, height: 800 },
];
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
const PDF = { mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 synthetic harness document — no real client data\n%%EOF') };
const addDays = (iso: string, n: number): string => {
  const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const dayText = (iso: string): string =>
  new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${iso.slice(0, 10)}T00:00:00Z`));

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
async function uploadSigned(token: string, fields: Record<string, string>, filename: string): Promise<void> {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  fd.append('file', new Blob([PDF.buffer], { type: PDF.mimeType }), filename);
  const r = await fetch(`${API}/documents`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: fd });
  const body = await r.json().catch(() => ({}));
  expect(r.status, `upload ${filename}: ${JSON.stringify(body)}`).toBeLessThan(300);
}

type State = 'mid-preparation' | 'filed-awaiting-acks' | 'completed';
/** A synthetic 1120S driven to one of the three states through the doors the walks tap. */
async function returnIn(token: string, state: State): Promise<{ contactId: string; te: string }> {
  const contact = await asStaff<{ id: string }>(token, '/contacts', {
    method: 'POST', body: JSON.stringify({ firstName: 'Synthetic', lastName: `Stepper ${state}`, email: `stepper-${state}@example.test` }),
  });
  const ret = await asStaff<{ id: string }>(token, '/tax-engagements', {
    method: 'POST',
    body: JSON.stringify({
      contactId: contact.id, taxYear: fixtures.scorp.taxYear, returnType: '1120s', clientType: 'business', preparerId: fixtures.scorp.preparer.id,
      reason: 'Harness screenshots: a return opened by hand so the stepper can be photographed in one state; no quote stands behind it.',
    }),
  });
  const te = ret.id;
  await uploadSigned(token, { contactId: contact.id, category: 'signed_authorizations', taxEngagementId: te, engagementLetterSignedOn: addDays(today, -12) }, `HARNESS-STEPPER-LETTER-${state}.pdf`);
  await post(token, `/tax-engagements/${te}/estimate`, { minCents: 60000, maxCents: 80000 });
  await post(token, `/tax-engagements/${te}/extension/filed`, { form: '7004', filedOn: addDays(today, -10) });
  for (const toStage of ['scheduled', 'documents_requested', 'in_preparation']) await post(token, `/tax-engagements/${te}/transition`, { toStage });
  if (state === 'mid-preparation') return { contactId: contact.id, te };

  for (const toStage of ['internal_review', 'client_review']) await post(token, `/tax-engagements/${te}/transition`, { toStage });
  await post(token, `/tax-engagements/${te}/8879-sent`, { method: 'adobe_sign', sentOn: addDays(today, -4) });
  await uploadSigned(token, { contactId: contact.id, category: 'signed_authorizations', taxEngagementId: te, signedOn: addDays(today, -3), preparerPtinHolderId: fixtures.scorp.preparer.id }, `HARNESS-STEPPER-8879-${state}.pdf`);
  await post(token, `/tax-engagements/${te}/final-fee`, { finalFeeCents: 70000 });
  await post(token, `/tax-engagements/${te}/transition`, { toStage: 'ready_to_file' });
  await post(token, `/tax-engagements/${te}/transition`, { toStage: 'filed', preparerPtinHolderId: fixtures.scorp.preparer.id, jurisdictions: ['federal', 'IL'], filedOn: addDays(today, -2) });
  if (state === 'filed-awaiting-acks') return { contactId: contact.id, te };

  // The acknowledgments, one per jurisdiction, then the client's payment as Stripe reports it.
  await post(token, `/tax-engagements/${te}/efile-result`, { result: 'accepted', jurisdiction: 'federal', asOf: addDays(today, -1) });
  await post(token, `/tax-engagements/${te}/efile-result`, { result: 'accepted', jurisdiction: 'state', stateCode: 'IL', asOf: today });
  const invoices = await asStaff<{ invoices: Array<{ id: string; status: string; tax_engagement_id: string | null }> }>(token, `/invoices?contactId=${contact.id}`);
  const inv = invoices.invoices.find((i) => i.status === 'sent');
  expect(inv, `the filing issued the final-fee invoice: ${JSON.stringify(invoices)}`).toBeTruthy();
  const paid = await fetch(`${API}/webhooks/stripe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-webhook-secret': fixtures.scorp.webhookSecret },
    body: JSON.stringify({ id: `evt_harness_stepper_${inv!.id}`, type: 'checkout.session.completed', data: { object: { id: `cs_stub_${inv!.id}`, payment_intent: `pi_harness_stepper_${inv!.id}`, metadata: { invoice_id: inv!.id } } } }),
  });
  expect(paid.status, 'the payment event').toBeLessThan(300);
  return { contactId: contact.id, te };
}

test('the three rail states at 390, 768 and 1280, at full resolution', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desk', 'one project sets the three widths itself');
  test.setTimeout(600_000);
  mkdirSync(SHOTS, { recursive: true });
  const token = await staffToken();
  const me = await asStaff<{ fullName: string }>(token, '/auth/me');
  const states: State[] = ['mid-preparation', 'filed-awaiting-acks', 'completed'];
  const returns = new Map<State, { contactId: string; te: string }>();
  for (const s of states) returns.set(s, await returnIn(token, s));
  const PHASES = ['engage', 'prepare', 'sign', 'file', 'close'] as const;
  const NAME = { engage: 'Engage', prepare: 'Prepare', sign: 'Sign', file: 'File', close: 'Close' } as const;

  await signIn(page, fixtures.staff);
  const saved: string[] = [];
  for (const size of WIDTHS) {
    await page.setViewportSize(size);
    for (const state of states) {
      const { contactId, te } = returns.get(state)!;
      await page.goto(`/clients/${contactId}`);
      const card = page.locator('section.card', { has: page.getByRole('heading', { name: 'Returns' }) });
      const stepper = card.getByTestId('return-stepper');
      await expect(stepper).toBeVisible();
      await expect(stepper.locator('li.phase'), 'five phases').toHaveCount(5);
      await expect(stepper.locator('li.phase.current'), 'at most one open phase').toHaveCount(state === 'completed' ? 0 : 1);
      await expect(stepper.getByTestId('current-step-control'), 'at most one control in the rail').toHaveCount(state === 'completed' ? 0 : 1);
      // The details area belongs to a return with something secondary left to do: before filing and while filed; not once completed.
      await expect(card.getByTestId('return-details')).toHaveCount(state === 'completed' ? 0 : 1);
      const width = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
      expect(width.scroll, `no page-level horizontal scroll at ${size.width} (${state})`).toBeLessThanOrEqual(width.client);
      /** A done phase: one line, check, name, date; a future phase: its name; neither draws a step. */
      const closedPhase = async (key: (typeof PHASES)[number], kind: 'done' | 'future', dateText?: string) => {
        const phase = stepper.getByTestId(`phase-${key}`);
        await expect(phase).toHaveAttribute('data-state', kind);
        await expect(phase, `${NAME[key]} ${kind}: one line`).toHaveText(kind === 'done' ? `✓${NAME[key]} · ${dateText}` : `${PHASES.indexOf(key) + 1}${NAME[key]}`);
        await expect(phase.locator('li.step'), `${NAME[key]}: no steps drawn`).toHaveCount(0);
      };

      if (state === 'mid-preparation') {
        await closedPhase('engage', 'done', dayText(today)); // dated by its last step, "scheduled", moved today
        const open = stepper.locator('li.phase.current');
        await expect(open).toHaveAttribute('data-testid', 'phase-prepare');
        await expect(open.locator('li.step')).toHaveCount(3);
        await expect(open.locator('li.step.done')).toHaveCount(2);
        await expect(open.locator('li.step.current')).toHaveAttribute('data-testid', 'step-internal_review');
        await expect(stepper.getByTestId('current-step-control').getByRole('button', { name: 'Internal review', exact: true }), 'the one control').toBeVisible();
        await expect(stepper.getByTestId('current-step-control'), 'and its one sentence').toContainText('Moves the return to internal review.');
        await expect(open.getByTestId('step-documents_requested'), 'a done step: check, name, day, person').toContainText(`Documents requested ${dayText(today)} · by ${me.fullName}`);
        await expect(open.getByTestId('step-in_preparation')).toContainText(`In preparation ${dayText(today)} · by ${me.fullName}`);
        await expect(stepper.getByTestId('step-letter'), 'a done phase’s steps are not drawn').toHaveCount(0);
        for (const key of ['sign', 'file', 'close'] as const) await closedPhase(key, 'future');
        await expect(card.getByText(/Extended · Form 7004 · deadline/), 'the extension lives in the details area').toBeVisible();
        await expect(card.getByText('extended', { exact: true }), 'and the badge on the header before filing').toBeVisible();
        await expect(card.getByTestId(`return-amount-${te}`), 'fix 3: the amount is labelled').toHaveText('Estimate up to $800.00');
        if (size.width === 390) {
          await expect(open, 'the current phase is in view when the row opens at 390').toBeInViewport();
          for (const target of [stepper.getByTestId('current-step-control').getByRole('button', { name: 'Internal review', exact: true }), card.getByTestId('assign-preparer')]) {
            const box = await target.boundingBox();
            expect(box && box.height >= 44, `a 44px target at 390 (got ${box?.height})`).toBeTruthy();
          }
        }
      }
      if (state === 'filed-awaiting-acks') {
        await closedPhase('engage', 'done', dayText(today));
        await closedPhase('prepare', 'done', dayText(today)); // internal review, moved today
        await closedPhase('sign', 'done', dayText(addDays(today, -3))); // the signed 8879, its last step
        const open = stepper.locator('li.phase.current');
        await expect(open).toHaveAttribute('data-testid', 'phase-file');
        await expect(open.locator('li.step')).toHaveCount(4);
        await expect(open.locator('li.step.done')).toHaveCount(3);
        await expect(open.locator('li.step.current')).toHaveAttribute('data-testid', 'step-jurisdictions');
        await expect(stepper.getByTestId('current-step-control'), 'no control of its own: it waits on ATX').toContainText('Waiting on the acknowledgments from ATX');
        await expect(open.getByTestId('step-final_fee')).toContainText('current $700.00');
        await expect(open.getByTestId('step-filed')).toContainText(`Filed ${dayText(addDays(today, -2))}`);
        await expect(open.getByTestId('step-filed')).toContainText(`preparer of record: ${fixtures.scorp.preparer.name}`);
        await expect(stepper.getByTestId('step-f8879_sent'), 'Sign is done: its steps are not drawn').toHaveCount(0);
        await closedPhase('close', 'future');
        // Fix 1: the jurisdictions print once — two lines, inside the one status block, as the body of the current step.
        await expect(card.getByTestId('jurisdiction-line-federal')).toHaveCount(1);
        await expect(card.getByTestId('jurisdiction-line-IL')).toHaveCount(1);
        await expect(open.getByTestId('jurisdiction-status')).toContainText('Awaiting acceptance');
        await expect(card.getByTestId('jurisdiction-record'), 'no second copy under the rail while File is open').toHaveCount(0);
        // Fix 2: no paper jurisdiction, no paper sentence.
        await expect(card.getByText(/A paper jurisdiction has no acknowledgment to wait for/)).toHaveCount(0);
        // Fix 4: the "extended" badge left with the filing; the extension itself is still in the details.
        await expect(card.getByText('extended', { exact: true })).toHaveCount(0);
        await expect(card.getByTestId('correct-filing'), 'the correction sits in the details area at filed').toBeVisible();
        await expect(card.getByTestId(`return-amount-${te}`)).toHaveText('Final fee $700.00');
        await expect(card.getByText('not filed'), 'the summary line does not repeat the steps').toHaveCount(0);
        if (size.width === 390) await expect(open, 'the current phase is in view at 390').toBeInViewport();
      }
      if (state === 'completed') {
        await expect(stepper.locator('li.phase.done'), 'five done lines').toHaveCount(5);
        await expect(stepper.locator('li.step'), 'nothing open').toHaveCount(0);
        await closedPhase('engage', 'done', dayText(today));
        await closedPhase('prepare', 'done', dayText(today));
        await closedPhase('sign', 'done', dayText(addDays(today, -3)));
        await closedPhase('file', 'done', dayText(today)); // the latest acceptance: IL, today
        await closedPhase('close', 'done', dayText(today)); // completed, its last step, moved today by automation
        // The record under the rail: where it was filed, readable at every stage; no mailing block once nothing is awaited.
        const record = card.getByTestId('jurisdiction-record');
        await expect(record).toHaveCount(1);
        await expect(record.getByTestId('jurisdiction-line-federal')).toContainText(`Accepted ${dayText(addDays(today, -1))}`);
        await expect(record.getByTestId('jurisdiction-line-IL')).toContainText(`Accepted ${dayText(today)}`);
        await expect(card.getByTestId('jurisdiction-line-federal'), 'printed once').toHaveCount(1);
        await expect(card.getByTestId('jurisdiction-status'), 'no mailing block once nothing is awaited').toHaveCount(0);
        await expect(card.getByTestId('return-details'), 'nothing secondary is left to do').toHaveCount(0);
      }
      const path = resolve(SHOTS, `${state}-${size.width}.png`);
      await page.screenshot({ path, fullPage: true, scale: 'device' });
      saved.push(path);
    }
  }
  for (const p of saved) testInfo.annotations.push({ type: 'screenshot', description: p });
  expect(saved.length, 'nine pictures').toBe(9);
});
