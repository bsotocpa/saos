/*
 * WHICH FIXTURE SET A PROJECT READS (Brian, 2026-09-30, R106).
 *
 * The walks were written for two projects, "phone" (390, WebKit) and "desk" (1280, Chromium), and the
 * harness fixtures hold one set of records for each. The six projects (375, 768 and 1440 in Chromium
 * and WebKit) each run against their own fresh harness (run-harness.mjs), so a project reads the set
 * for its width: under 768 the narrow set ("phone"), otherwise the wide one ("desk"). The same split is
 * the layout's own: R105 stacks a list into cards below 768. A walk that names its screenshots or its
 * evidence by project uses the project name, so the six never overwrite one another.
 */
import type { TestInfo } from '@playwright/test';

export type ViewportKey = 'phone' | 'desk';

/** The fixture set and layout this project reads: 'phone' under 768 wide, 'desk' at 768 and wider. */
export function viewportKey(testInfo: TestInfo): ViewportKey {
  const width = testInfo.project.use.viewport?.width ?? 1280;
  return width < 768 ? 'phone' : 'desk';
}
