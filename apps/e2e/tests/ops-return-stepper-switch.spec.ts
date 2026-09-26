/*
 * THE RETURNS CARD SWITCH (Brian, 2026-09-26, R50; the dark-ship rule R57). OPS_RETURN_STEPPER decides
 * what renders under each return on /clients/:id: off, the row production runs today (the default);
 * on, the stepper, shown only when the server says so. One API process serves both: the harness door
 * /harness/return-stepper flips it, and this spec reads what a person sees in each state, at 390 and
 * 1280 — path S:
 *
 *   S1  the stepper's current step carries its one control and one sentence (the harness return has
 *       no letter yet, so the current step is "Letter signed" and the control is the letter upload),
 *       every later step says what unlocks it, and no other step offers a control;
 *   S2  the details area carries the secondary actions — change/assign the preparer, record the
 *       extension — and nothing else; the role proof: ed_coo (engagements.read, no
 *       engagements.tax.manage) reads the steps and gets no control and no details area;
 *   S3  with the switch off the row renders as before: its "Lock estimate" grid and no stepper;
 *       GET /auth/me reports the state the page decides from.
 *
 * The switch is put back to ON whatever happens, so the specs after this one tap the stepper.
 */
import { expect, test, type Page } from '@playwright/test';
import * as OTPAuth from 'otpauth';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
interface Persona { email: string; password: string; totpSecret: string }
const fixtures = JSON.parse(readFileSync(resolve(here, '..', '.artifacts', 'fixtures.json'), 'utf8')) as {
  port: number;
  contactId: string;
  staff: Persona;
  wall: { jaqueline: Persona; taxEngagementId: string };
};
const API = `http://127.0.0.1:${fixtures.port}`;
const ROLES = 'tax_preparer, ceo (engagements.tax.manage); read: ed_coo (engagements.read)';

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

/** The harness's own flip: the body is the state, the answer is the state now held. */
async function flip(state: 'on' | 'off'): Promise<string> {
  const r = await fetch(`${API}/harness/return-stepper`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ state }) });
  const body = (await r.json().catch(() => ({}))) as { returnStepper?: string };
  if (r.status !== 200) throw new Error(`the harness flip answered ${r.status}: ${JSON.stringify(body)}`);
  return body.returnStepper ?? '';
}

test('off renders the row with its control grid; on renders the stepper with one control on the current step and a details area', async ({ page }, testInfo) => {
  const viewport = testInfo.project.name;
  const steps: string[] = [];
  const clientPage = `/clients/${fixtures.contactId}`;
  // The harness client carries more than one return; every read is scoped to the fixture return's row.
  const card = page.locator('section.card', { has: page.getByRole('heading', { name: 'Returns' }) })
    .locator('.quote-line', { has: page.getByTestId(`return-amount-${fixtures.wall.taxEngagementId}`) });
  try {
    await signIn(page, fixtures.staff);

    // ── S3. OFF: the production default. ────────────────────────────────────────────────
    expect(await flip('off'), 'the switch is off for this half').toBe('off');
    const me0 = await page.evaluate(async () => (await fetch('/api/auth/me')).json() as Promise<{ switches?: { returnStepper?: string } }>);
    expect(me0.switches?.returnStepper, 'the session reports the state the page decides from').toBe('off');
    await page.goto(clientPage);
    await expect(page.getByRole('heading', { name: 'Returns' })).toBeVisible();
    await expect(card.getByRole('button', { name: 'Lock estimate' }), 'off: the row’s control grid').toBeVisible();
    await expect(card.getByText('not filed'), 'off: the row’s summary line').toBeVisible();
    await expect(card.getByTestId('return-stepper'), 'off: no stepper').toHaveCount(0);
    await expect(card.getByTestId('return-details')).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath(`return-stepper-off-${viewport}.png`), fullPage: true });
    steps.push(`S3|OPS_RETURN_STEPPER=off (through /harness/return-stepper): /clients/:id Returns card renders the row — "Lock estimate" grid, the "not filed" summary, no stepper; GET /auth/me switches.returnStepper reads off|${ROLES}|tap`);

    // ── S1. ON: the stepper, one control on the current step. ──────────────────────────
    expect(await flip('on'), 'the switch is on for this half').toBe('on');
    const me1 = await page.evaluate(async () => (await fetch('/api/auth/me')).json() as Promise<{ switches?: { returnStepper?: string } }>);
    expect(me1.switches?.returnStepper).toBe('on');
    await page.goto(clientPage);
    const stepper = card.getByTestId('return-stepper');
    await expect(stepper, 'on: the stepper').toBeVisible();
    await expect(card.getByText('not filed'), 'on: the steps say it, the summary line does not repeat it').toHaveCount(0);
    await expect(stepper.locator('li.step'), 'sixteen steps').toHaveCount(16);
    // The harness return has no letter, so the first step is current and carries the one control.
    const current = stepper.locator('li.step.current');
    await expect(current).toHaveCount(1);
    await expect(current, 'the current step is the letter').toHaveAttribute('data-testid', 'step-letter');
    const control = current.getByTestId('current-step-control');
    await expect(control.getByTestId('upload-engagement-letter'), 'its one control: the letter upload').toBeVisible();
    await expect(control.getByText(/signs the engagement packet in the portal/), 'and its one sentence').toBeVisible();
    await expect(stepper.getByTestId('current-step-control'), 'no other step carries a control').toHaveCount(1);
    await expect(stepper.locator('li.step.later'), 'the fifteen others are later').toHaveCount(15);
    await expect(stepper.getByTestId('step-preparer').getByText(/Unlocks when the engagement letter is signed/), 'a later step says what unlocks it').toBeVisible();
    await expect(stepper.getByTestId('step-f8879_sent').getByText(/Unlocks when the return has been delivered/)).toBeVisible();
    await expect(stepper.getByTestId('step-f8879_on_file').getByText(/Unlocks when the 8879 has been sent/)).toBeVisible();
    // R50 fix 3: the amount is labelled. The harness return has no estimate yet.
    await expect(card.getByTestId(`return-amount-${fixtures.wall.taxEngagementId}`)).toHaveText('No fee yet');
    if (viewport === 'phone') {
      const width = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
      expect(width.scroll, 'no page-level horizontal scroll at 390').toBeLessThanOrEqual(width.client);
      for (const target of [control.getByTestId('upload-engagement-letter'), card.getByTestId('assign-preparer'), card.getByTestId('record-extension')]) {
        const box = await target.boundingBox();
        expect(box && box.height >= 44, `a 44px target at 390 (got ${box?.height})`).toBeTruthy();
      }
    }
    await page.screenshot({ path: testInfo.outputPath(`return-stepper-on-${viewport}.png`), fullPage: true });
    steps.push(`S1|OPS_RETURN_STEPPER=on: /clients/:id Returns card renders the stepper (16 steps); the current step "Letter signed" carries the letter upload and one sentence, no other step has a control, each later step prints what unlocks it|${ROLES}|tap`);

    // ── S2. THE DETAILS AREA, and the role proof. ──────────────────────────────────────
    const details = card.getByTestId('return-details');
    await expect(details).toBeVisible();
    await expect(details.getByTestId('assign-preparer'), 'the preparer is changed from the details area').toBeVisible();
    await expect(details.getByTestId('record-extension'), 'the extension is recorded from the details area').toBeVisible();
    await expect(details.getByTestId('correct-filing'), 'nothing to correct before filing').toHaveCount(0);
    await details.getByTestId('record-extension').click();
    const dialog = page.locator('[role=dialog]');
    await expect(dialog.getByTestId('extension-form'), 'the same Record extension modal the row opens').toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);

    await signIn(page, fixtures.wall.jaqueline);
    await page.goto(clientPage);
    await expect(card.getByTestId('return-stepper'), 'ed_coo reads the steps').toBeVisible();
    await page.waitForTimeout(800);
    await expect(card.getByTestId('current-step-control'), 'and gets no control').toHaveCount(0);
    await expect(card.getByTestId('return-details'), 'and no details area').toHaveCount(0);
    for (const id of ['upload-engagement-letter', 'assign-preparer', 'record-extension', 'record-8879-sent', 'upload-signed-8879']) {
      await expect(page.getByTestId(id), `${id} is not on her page`).toHaveCount(0);
    }
    steps.push(`S2|the details area under the steps: "Change preparer"/"Assign preparer" (assign-preparer) and "Record extension" (opens the shared modal; cancelled), no "Correct the filing" before filing; role proof: ed_coo reads the sixteen steps with no control and no details area|${ROLES}|tap`);
  } finally {
    // Whatever happened above, the specs after this one tap the stepper.
    expect(await flip('on'), 'the switch is back to on').toBe('on');
    for (const s of steps) testInfo.annotations.push({ type: 'walk-step', description: s });
  }
});
