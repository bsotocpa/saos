'use client';

/*
 * A FORM THAT RENDERS BEFORE ITS PAGE HYDRATES (2026-09-29, receipt runs 34 and 35).
 *
 * The server sends the fields; React takes them over a moment later and sets each to its state. Text
 * typed in that moment (a quick person on a phone, the harness at 390) is reset to empty by the
 * hydration: run 34 lost the sign-in Email, run 35 the Add staff Legal name. The fields render disabled
 * until React owns them, so nothing can be typed into a field about to be reset; Playwright's fill
 * waits for an enabled field on its own. The Ops shell wraps every page in one (receipt run 36 lost a
 * third form the same way, so the fix belongs to the shell, not to each form): the fieldset's effect runs
 * after its whole subtree has hydrated. A form may still wrap its own fields; nesting is harmless.
 */
import { useEffect, useState, type ReactNode } from 'react';

export function HydratedFieldset({ children }: { children: ReactNode }): React.JSX.Element {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => { setHydrated(true); }, []);
  return (
    <fieldset disabled={!hydrated} data-hydrated={hydrated ? 'true' : 'false'} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
      {children}
    </fieldset>
  );
}
