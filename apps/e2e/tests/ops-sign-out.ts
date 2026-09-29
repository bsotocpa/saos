/*
 * SIGNING A STAFF MEMBER OUT BETWEEN STEPS OF ONE WALK (2026-09-29, R7).
 *
 * The walks used to log out with a fetch from whatever Ops page was open. That page keeps reading
 * the API; its next read answered 401 and the app sent itself to /login, while the walk's own
 * page.goto('/login') was in flight, and one navigation aborted the other (net::ERR_ABORTED, the MFA
 * walk at 1280, 2026-09-29). Now the walk steps onto /login first, while the session is still good
 * and nothing can redirect, and logs out there, where the page reads nothing.
 */
import type { Page } from '@playwright/test';

export async function opsSignOut(page: Page): Promise<void> {
  await page.goto('/login');
  await page.evaluate(async () => {
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
    sessionStorage.removeItem('saos_staff_authed');
  });
}
