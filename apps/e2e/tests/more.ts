/*
 * R105 RULE 4 (2026-10-01): below 768 an action group's secondary actions sit behind "More"
 * (apps/internal/components/more-actions.tsx). A walk that taps one opens the menu first, the way a
 * person on a phone would; at 768 and wider there is no menu and this does nothing.
 */
import type { Locator } from '@playwright/test';

export async function openMore(scope: Locator): Promise<void> {
  const more = scope.locator('button.more-toggle').first();
  if (!(await more.isVisible().catch(() => false))) return;
  if ((await more.getAttribute('aria-expanded')) !== 'true') await more.click();
}
