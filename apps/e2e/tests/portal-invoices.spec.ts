/*
 * PAGE TWO: the portal → Invoices, in English AND Spanish, at 390 × 844 and 1280 × 800
 * (Brian's ruling, 2026-09-10, unlocked by five consecutive green runs of page one).
 *
 * Page one reads the staff side of the same invoices. This reads what the CLIENT is shown, in
 * both languages, because CLAUDE.md requires every client-facing string in English and Spanish
 * and nothing in the API suite can tell whether a rendered page honoured that.
 *
 * The way in is the real one: 'Grant access' on the Ops client page emails a sign-in link, the
 * fixture's mailer keeps it, and this logs in by redeeming it — the client's own path, not a
 * session minted behind the route's back.
 *
 * A failing run writes its screenshots to tasks/walks/<date>/; a passing run keeps them under
 * .artifacts/<date>/ for 14 days.
 */
import { expect, test, type Page } from '@playwright/test';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..');
const fixtures = JSON.parse(readFileSync(resolve(here, '..', '.artifacts', 'fixtures.json'), 'utf8')) as {
  contactId: string; portalMagicTokens: string[]; portalPort: number;
};
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
const ISO_T = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/*
 * The words the client must see, per language, from apps/portal/lib/i18n.ts. Hard-coded here on
 * purpose: importing the dictionary would let a wrong translation agree with itself. A walk
 * checks the page against what a person was promised, not against the source of the mistake.
 */
const COPY = {
  en: { title: 'Invoices & Payments', open: 'Open', paid: 'Paid', cancelled: 'Cancelled', refunded: 'Refunded', pay: 'Pay now', toggle: 'Español' },
  es: { title: 'Facturas y pagos', open: 'Pendiente', paid: 'Pagada', cancelled: 'Anulada', refunded: 'Reembolsada', pay: 'Pagar ahora', toggle: 'English' },
} as const;
type Lang = keyof typeof COPY;

test.use({ baseURL: `http://localhost:${fixtures.portalPort ?? 3106}` });

// A magic link is single use, so each viewport redeems its own (the fixture minted one each).
async function signIn(page: Page, which: number): Promise<void> {
  await page.goto('/login');
  const status = await page.evaluate(async (token) => {
    const r = await fetch('/api/portal/auth/magic/verify', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }),
    });
    localStorage.setItem('saos_portal_authed', '1');
    return r.status;
  }, fixtures.portalMagicTokens[which] ?? '');
  expect(status, 'redeeming the sign-in link the client was emailed').toBe(200);
}

function keepScreenshot(name: string, passed: boolean, file: string): string {
  const dir = passed ? resolve(here, '..', '.artifacts', today) : resolve(root, 'tasks', 'walks', today);
  mkdirSync(dir, { recursive: true });
  const target = resolve(dir, `${name}.png`);
  if (existsSync(file)) copyFileSync(file, target);
  return target;
}

/*
 * The toggle PERSISTS to the contact record, so whichever viewport runs first leaves the client
 * in the language it finished in. This makes the starting language explicit instead of assuming
 * it, and each run puts English back when it is done.
 */
async function ensureLang(page: Page, want: Lang): Promise<void> {
  for (let i = 0; i < 3; i++) {
    const text = await page.evaluate(() => document.body.innerText);
    if (text.includes(COPY[want].title)) return;
    await page.getByTestId('lang-toggle').click();
    await page.waitForTimeout(600);
  }
  throw new Error(`the portal would not switch to ${want}`);
}

/** Every assertion that must hold whatever language the page is in. */
async function readsWell(page: Page, lang: Lang, viewport: string): Promise<void> {
  const words = COPY[lang];
  const text = await page.evaluate(() => document.body.innerText);

  // 1. The page is in the language it claims.
  expect(text, `${lang}: the title`).toContain(words.title);
  const other = lang === 'en' ? COPY.es : COPY.en;
  expect(text, `${lang}: no ${lang === 'en' ? 'Spanish' : 'English'} title leaking through`).not.toContain(other.title);

  // 2. Every invoice state the fixture holds reads as a word in this language, never the enum.
  expect(text, `${lang}: the paid invoice`).toContain(words.paid);
  expect(text, `${lang}: the open invoice`).toContain(words.open);
  expect(text, `${lang}: the refunded invoice`).toContain(words.refunded);
  for (const raw of ['partially_refunded', 'not_on_file', 'on_hold', 'void ·']) {
    expect(text, `${lang}: no raw enum '${raw}'`).not.toContain(raw);
  }

  // 3. A cancelled invoice is visible to the client and offers no way to pay it.
  //    (Evening ruling E, 2026-09-09: the portal shows void invoices, sorted last, no pay action.)
  const cancelled = page.locator('li', { hasText: words.cancelled }).first();
  await expect(cancelled, `${lang}: the cancelled invoice is on the page`).toBeVisible();
  expect(await cancelled.getByRole('button', { name: words.pay }).count(), `${lang}: no pay control on a cancelled invoice`).toBe(0);

  // 4. The open invoice does offer one, and it is reachable at this viewport.
  const payButtons = page.getByRole('button', { name: words.pay });
  expect(await payButtons.count(), `${lang}: exactly one payable invoice`).toBe(1);
  await expect(payButtons.first()).toBeEnabled();

  // 5. No raw timestamp, no wrong-helper marker.
  expect(text, `${lang}: no ISO-T leak`).not.toMatch(ISO_T);
  expect(text, `${lang}: no wrong-helper marker`).not.toContain('⚠');

  // 6. Nothing overflows. Spanish is the longer language and this is where it shows.
  const widths = await page.evaluate(() => ({ vw: document.documentElement.clientWidth, sw: document.documentElement.scrollWidth }));
  expect(widths.sw, `${lang} at ${viewport}: the page fits its viewport`).toBe(widths.vw);

  // 7. Nothing renders as a dash, an undefined or a NaN where a value belongs.
  for (const wrong of ['undefined', 'NaN', '$NaN', 'null']) {
    expect(text, `${lang}: no '${wrong}' on the page`).not.toContain(wrong);
  }
}

test.describe('portal → Invoices', () => {
  test('reads to the client in both languages, at this viewport', async ({ page }, testInfo) => {
    const viewport = testInfo.project.name; // phone | desk
    let passed = false;
    const shots: Array<{ lang: Lang; file: string }> = [];
    try {
      await signIn(page, testInfo.project.name === 'phone' ? 0 : 1);
      await page.goto('/invoices');
      await expect(page.locator('h1')).toBeVisible();
      await page.waitForTimeout(1000);
      await ensureLang(page, 'en');

      /*
       * THE PICTURE COMES FIRST. A Spanish failure used to keep the English screenshot, because
       * the shot was taken after the assertions passed — so the evidence showed the page that
       * was fine. Shoot, record, then assert.
       */
      const enShot = testInfo.outputPath(`portal-invoices-en-${viewport}.png`);
      await page.screenshot({ path: enShot, fullPage: true });
      shots.push({ lang: 'en', file: enShot });
      await readsWell(page, 'en', viewport);

      // Then the toggle the client actually has, and the same page in Spanish. The control
      // carries aria-label="Language toggle", so its accessible name is not the word printed on
      // it — the test id is what identifies it.
      await page.getByTestId('lang-toggle').click();
      await expect(page.getByRole('heading', { name: COPY.es.title })).toBeVisible();
      await page.waitForTimeout(500);
      const esShot = testInfo.outputPath(`portal-invoices-es-${viewport}.png`);
      await page.screenshot({ path: esShot, fullPage: true });
      shots.push({ lang: 'es', file: esShot });
      await readsWell(page, 'es', viewport);

      // The choice sticks across a reload — it is saved on the client, not held in the tab.
      await page.reload();
      await expect(page.getByRole('heading', { name: COPY.es.title })).toBeVisible();

      // Leave the client as we found them, so the next viewport starts where this one did.
      await ensureLang(page, 'en');
      passed = true;
    } finally {
      if (shots.length === 0) {
        const fallback = testInfo.outputPath(`portal-invoices-${viewport}.png`);
        await page.screenshot({ path: fallback, fullPage: true });
        shots.push({ lang: 'en', file: fallback });
      }
      for (const s of shots) {
        const kept = keepScreenshot(`portal-invoices-${s.lang}-${viewport}`, passed, s.file);
        testInfo.annotations.push({ type: passed ? 'artifact' : 'failure-screenshot', description: kept });
      }
    }
  });
});
