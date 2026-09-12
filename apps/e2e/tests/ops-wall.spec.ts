/*
 * PAGE FOUR: the §7216 wall, as Laura (va_entity) and Jaqueline (ed_coo) would see it
 * (phase 2, 2026-09-12, Brian's ruling). Each persona signs in to the production build of Ops,
 * opens the harness client, and the page they read must carry none of the four things behind the
 * wall: the SSN last-4, a tax-category document, an interview answer, a CPA session's transcript
 * or summary. Then the same session asks the API directly, the way the page's own JavaScript
 * would, for the quote, the tax engagement, the transcript and the tax document: each answer must
 * be empty of the marker too. Positive controls prove the wall is category-shaped, not a blank
 * page: Laura sees the entity filing, Jaqueline sees the bank statement.
 *
 * Every marker is synthetic and unique, so "absent" means the bytes are not on the page, not that
 * a label happened to change.
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
  contactId: string;
  wall: {
    laura: Persona; jaqueline: Persona;
    quoteId: string; taxEngagementId: string; cpaMeetingId: string; taxDocumentId: string;
    entityDocumentId: string; bankDocumentId: string;
    markers: { ssnLast4: string; taxDoc: string; irsNotice: string; bankDoc: string; entityDoc: string; interview: string; complexity: string; transcript: string; summary: string };
  };
};
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());

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

/** What the signed-in session gets back from the API, as text, plus the status. */
async function ask(page: Page, path: string): Promise<{ status: number; body: string }> {
  return page.evaluate(async (p) => {
    const r = await fetch(`/api${p}`);
    return { status: r.status, body: await r.text() };
  }, path);
}

function keepScreenshot(name: string, passed: boolean, file: string): string {
  const dir = passed ? resolve(here, '..', '.artifacts', today) : resolve(root, 'tasks', 'walks', today);
  mkdirSync(dir, { recursive: true });
  const target = resolve(dir, `${name}.png`);
  if (existsSync(file)) copyFileSync(file, target);
  return target;
}

const M = fixtures.wall.markers;
const behindTheWall = [M.ssnLast4, M.taxDoc, M.irsNotice, M.interview, M.complexity, M.transcript, M.summary];

for (const [name, persona, positive, negativeToo] of [
  ['laura', fixtures.wall.laura, M.entityDoc, [M.bankDoc]],
  ['jaqueline', fixtures.wall.jaqueline, M.bankDoc, []],
] as const) {
  test.describe(`Ops → client page behind the wall, as ${name}`, () => {
    test('none of the four things are on the page, and the API says the same to this session', async ({ page }, testInfo) => {
      const viewport = testInfo.project.name;
      const shot = testInfo.outputPath(`wall-${name}-${viewport}.png`);
      let passed = false;
      try {
        await signIn(page, persona);
        await page.goto(`/clients/${fixtures.contactId}`);
        await expect(page.getByRole('heading', { name: /Documents \(/ })).toBeVisible();
        await page.waitForTimeout(1500);

        const text = await page.evaluate(() => document.body.innerText);
        for (const marker of behindTheWall) expect(text, `${marker} is not on ${name}'s page`).not.toContain(marker);
        for (const marker of negativeToo) expect(text, `${marker} is not on ${name}'s page`).not.toContain(marker);
        // The positive control: the wall is category-shaped. The allowed document is on the page.
        expect(text, `${positive} IS on ${name}'s page`).toContain(positive);

        // The same session, asking the API the way the page would.
        const quote = await ask(page, `/quotes/${fixtures.wall.quoteId}`);
        expect(quote.body, 'the quote carries no interview answer').not.toContain(M.interview);
        const te = await ask(page, `/tax-engagements/${fixtures.wall.taxEngagementId}`);
        expect(te.body, 'the tax engagement carries no complexity input').not.toContain(M.complexity);
        const transcript = await ask(page, `/meetings/${fixtures.wall.cpaMeetingId}/transcript`);
        expect(transcript.status, 'the CPA session transcript is not served').not.toBe(200);
        expect(transcript.body, 'nor leaked in the error').not.toContain(M.transcript);
        const detail = await ask(page, `/meetings/${fixtures.wall.cpaMeetingId}`);
        expect(detail.status, 'the CPA session detail is not served').not.toBe(200);
        expect(detail.body).not.toContain(M.summary);
        const taxDoc = await ask(page, `/documents/${fixtures.wall.taxDocumentId}/download`);
        expect(taxDoc.status, 'the tax document does not download').not.toBe(200);
        const contact = await ask(page, `/contacts/${fixtures.contactId}`);
        expect(contact.status, 'the client record opens').toBe(200);
        expect(contact.body, 'without the SSN last-4').not.toContain(M.ssnLast4);
        expect(contact.body, 'and says so').toContain('pii_withheld');
        const positiveDoc = await ask(page, `/documents/${name === 'laura' ? fixtures.wall.entityDocumentId : fixtures.wall.bankDocumentId}/download`);
        expect(positiveDoc.status, `${name}'s allowed document downloads`).toBe(200);

        await page.screenshot({ path: shot, fullPage: true });
        passed = true;
      } finally {
        if (!existsSync(shot)) await page.screenshot({ path: shot, fullPage: true }).catch(() => undefined);
        const kept = keepScreenshot(`wall-${name}-${viewport}`, passed, shot);
        testInfo.annotations.push({ type: 'screenshot', description: kept });
      }
    });
  });
}
