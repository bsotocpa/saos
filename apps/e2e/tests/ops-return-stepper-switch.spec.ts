/*
 * THE RETURNS CARD SWITCH (Brian, 2026-09-26, R50; rebuilt 2026-09-27 as five phases, R50 v2; the
 * dark-ship rule R57). OPS_RETURN_STEPPER decides what renders under each return on /clients/:id: off,
 * the row production runs today (the default); on, the rail of phases, shown only when the server says
 * so. One API process serves both: the harness door /harness/return-stepper flips it, and this spec
 * reads what a person sees in each state, at 390 and 1280 — path S:
 *
 *   S1  the rail shows five phases; only the current phase is open (the harness return has no letter
 *       yet, so Engage is current), its current step "Letter signed" carries the one control (the
 *       letter upload) and one sentence, its other three steps are one line each, no other step or
 *       phase offers a control; a future phase is its greyed name with no steps drawn; on the phone
 *       the current phase is in view when the row opens;
 *   S2  the details area carries the secondary actions — change/assign the preparer, record the
 *       extension — and nothing else; the role proof: ed_coo (engagements.read, no
 *       engagements.tax.manage) reads the phases and gets no control and no details area;
 *   S3  with the switch off the row renders as before: its "Lock estimate" grid and no stepper;
 *       GET /auth/me reports the state the page decides from.
 *
 * The harness return has nothing done, so no phase is done here; the one-line done phase (check, name,
 * date) is read by return-stepper-shots.spec.ts on returns driven to mid-preparation, filed and completed.
 * The switch is put back to ON whatever happens, so the specs after this one tap the stepper.
 */
import { expect, test, type Page } from '@playwright/test';
import * as OTPAuth from 'otpauth';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { viewportKey } from './viewport';

const here = dirname(fileURLToPath(import.meta.url));
interface Persona { email: string; password: string; totpSecret: string }
const fixtures = JSON.parse(readFileSync(resolve(here, '..', process.env.E2E_ARTIFACTS ?? '.artifacts', 'fixtures.json'), 'utf8')) as {
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

test('off renders the row with its control grid; on renders the rail of five phases with one control on the current step of the open phase and a details area', async ({ page }, testInfo) => {
  const viewport = viewportKey(testInfo);
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

    // ── S1. ON: the rail of five phases, one open, one control. ───────────────────────
    expect(await flip('on'), 'the switch is on for this half').toBe('on');
    const me1 = await page.evaluate(async () => (await fetch('/api/auth/me')).json() as Promise<{ switches?: { returnStepper?: string } }>);
    expect(me1.switches?.returnStepper).toBe('on');
    await page.goto(clientPage);
    const stepper = card.getByTestId('return-stepper');
    await expect(stepper, 'on: the rail').toBeVisible();
    await expect(card.getByText('not filed'), 'on: the phases say it, the summary line does not repeat it').toHaveCount(0);
    await expect(stepper.locator('li.phase'), 'five phases').toHaveCount(5);
    await expect(stepper.locator('li.phase')).toHaveText([/Engage/, /Prepare/, /Sign/, /File/, /Close/]);
    // The harness return has no letter: Engage is the current phase and the only one open.
    const openPhase = stepper.locator('li.phase.current');
    await expect(openPhase).toHaveCount(1);
    await expect(openPhase, 'the current phase is Engage').toHaveAttribute('data-testid', 'phase-engage');
    await expect(openPhase.locator('li.step'), 'open: its four steps').toHaveCount(4);
    await expect(stepper.locator('li.phase.done'), 'nothing is done on the harness return: no done phase here (the shots spec reads those)').toHaveCount(0);
    await expect(stepper.locator('li.phase.future'), 'the four others are future').toHaveCount(4);
    for (const [key, label, n] of [['prepare', 'Prepare', 2], ['sign', 'Sign', 3], ['file', 'File', 4], ['close', 'Close', 5]] as const) {
      const phase = stepper.getByTestId(`phase-${key}`);
      await expect(phase).toHaveAttribute('data-state', 'future');
      await expect(phase, `${label}: its name alone`).toHaveText(`${n}${label}`);
      await expect(phase.locator('li.step'), `${label}: no steps drawn`).toHaveCount(0);
    }
    // Greyed: the future phase's name is set in the muted token, read from the rendered colour.
    const grey = await stepper.evaluate((ol) => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--muted)';
      document.body.appendChild(probe);
      const want = getComputedStyle(probe).color;
      probe.remove();
      return { want, got: [...ol.querySelectorAll('li.phase.future .phase-label')].map((el) => getComputedStyle(el).color) };
    });
    expect(grey.got, 'the four future names are greyed with the muted token').toEqual([grey.want, grey.want, grey.want, grey.want]);
    // Inside the open phase: the current step carries the one control and one sentence; the others are one line.
    const current = openPhase.locator('li.step.current');
    await expect(current).toHaveCount(1);
    await expect(current, 'the current step is the letter').toHaveAttribute('data-testid', 'step-letter');
    const control = current.getByTestId('current-step-control');
    await expect(control.getByTestId('upload-engagement-letter'), 'its one control: the letter upload').toBeVisible();
    await expect(control.getByText(/signs the engagement packet in the portal/), 'and its one sentence').toBeVisible();
    await expect(stepper.getByTestId('current-step-control'), 'exactly one control in the whole rail').toHaveCount(1);
    await expect(openPhase.locator('li.step.later'), 'the other three steps of Engage are later').toHaveCount(3);
    // R50 v3 approval (2026-09-29): a step carries no number; only the five phases are numbered.
    for (const [key, label] of [['preparer', 'Preparer assigned'], ['estimate', 'Estimate locked'], ['scheduled', 'Scheduled']] as const) {
      await expect(openPhase.getByTestId(`step-${key}`), `${key}: one line, its name alone, no number`).toHaveText(label);
    }
    await expect(stepper.getByTestId('step-f8879_sent'), 'a step of a future phase is not drawn').toHaveCount(0);
    await expect(stepper.getByTestId('step-completed')).toHaveCount(0);
    // R50 fix 3: the amount is labelled. The harness return has no estimate yet.
    await expect(card.getByTestId(`return-amount-${fixtures.wall.taxEngagementId}`)).toHaveText('No fee yet');
    if (viewport === 'phone') {
      const width = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
      expect(width.scroll, 'no page-level horizontal scroll at 390').toBeLessThanOrEqual(width.client);
      // The top return's rail scrolls its current phase into view when the row opens (one scroll per page).
      await expect(page.getByTestId('return-stepper').first().locator('li.phase.current'), 'the current phase is in view at 390').toBeInViewport();
      for (const target of [control.getByTestId('upload-engagement-letter'), card.getByTestId('assign-preparer'), card.getByTestId('record-extension')]) {
        const box = await target.boundingBox();
        expect(box && box.height >= 44, `a 44px target at 390 (got ${box?.height})`).toBeTruthy();
      }
    }
    await page.screenshot({ path: testInfo.outputPath(`return-stepper-on-${viewport}.png`), fullPage: true });
    steps.push(`S1|OPS_RETURN_STEPPER=on: /clients/:id Returns card renders the rail of five phases; Engage is open with its four steps, "Letter signed" carries the letter upload and one sentence, the other three steps are one line each; Prepare, Sign, File, Close are their greyed names with no steps; one control in the rail${viewport === 'phone' ? '; the current phase is in view at 390' : ''}|${ROLES}|tap`);

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
    await expect(card.getByTestId('return-stepper'), 'ed_coo reads the phases').toBeVisible();
    await expect(card.locator('li.phase')).toHaveCount(5);
    await page.waitForTimeout(800);
    await expect(card.getByTestId('current-step-control'), 'and gets no control').toHaveCount(0);
    await expect(card.getByTestId('return-details'), 'and no details area').toHaveCount(0);
    for (const id of ['upload-engagement-letter', 'assign-preparer', 'record-extension', 'record-8879-sent', 'upload-signed-8879']) {
      await expect(page.getByTestId(id), `${id} is not on her page`).toHaveCount(0);
    }
    steps.push(`S2|the details area under the rail: "Change preparer"/"Assign preparer" (assign-preparer) and "Record extension" (opens the shared modal; cancelled), no "Correct the filing" before filing; role proof: ed_coo reads the five phases with no control and no details area|${ROLES}|tap`);
  } finally {
    // Whatever happened above, the specs after this one tap the stepper.
    expect(await flip('on'), 'the switch is back to on').toBe('on');
    for (const s of steps) testInfo.annotations.push({ type: 'walk-step', description: s });
  }
});
