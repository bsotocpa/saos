/*
 * SIGNING THE CLIENT IN, THE WAY THE PORTAL DOES IT (receipt run 42, R7, 2026-09-29).
 *
 * The walks used to redeem the sign-in token with a fetch from /login and write the portal's
 * "signed in" marker into localStorage themselves, then navigate straight on. In WebKit (the phone
 * project) a navigation can land in a new web process that reads localStorage before the previous
 * process's write has reached it; under a loaded receipt run the write lost that race, Home read no
 * marker and sent the client to /login (run 42, B3c-B3d at 390). Now the walk opens the verify page
 * the emailed link opens and presses its one button: the portal redeems the token, writes its own
 * marker, checks the session and moves to Home client-side, and the walk waits until the marker
 * reads back in this page before it goes anywhere.
 */
import { expect, type Page } from '@playwright/test';

export async function redeemPortalToken(page: Page, portalOrigin: string, token: string): Promise<void> {
  await page.goto(`${portalOrigin}/auth/verify?token=${encodeURIComponent(token)}`);
  await page.getByTestId('verify-press').click();
  await page.waitForURL((u) => new URL(u).pathname === '/');
  // Home's own reads finish before the walk moves on: a fetch cut off by the next navigation is a
  // page error in WebKit, and walks that assert a clean console would read it as theirs.
  await page.waitForLoadState('networkidle');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('saos_portal_authed')), { message: 'the portal wrote its signed-in marker' }).toBe('1');
}
