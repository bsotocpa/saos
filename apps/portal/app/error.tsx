'use client';

/*
 * THE PORTAL'S ERROR BOUNDARY (R49, Brian, 2026-09-26).
 *
 * Before this file existed, a render error anywhere under the layout left the client with Next's
 * bare "Application error: a client-side exception has occurred" and nobody at the firm knew. Now
 * a failed page shows one plain sentence in the client's language and a Reload control, and the
 * failure is posted to POST /portal/client-errors (route and message only, no personal data),
 * which opens a task and raises an Ops alert so the page is fixed before the next client meets it.
 *
 * The button reloads the document rather than calling Next's reset(): the failures this catches
 * are render failures on fetched data, and re-rendering the same state re-throws.
 */
import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { useSession } from '../lib/session';

export function reportClientError(route: string, error: { message?: string; digest?: string }): Promise<void> {
  const body = JSON.stringify({
    route: route.slice(0, 200),
    message: String(error.message ?? 'render failed').slice(0, 500),
    ...(error.digest ? { digest: String(error.digest).slice(0, 100) } : {}),
  });
  // Plain fetch, not api(): a 401 here must not redirect the person away from the sentence they
  // are reading, and a failure to report is not something to show them.
  return fetch('/api/portal/client-errors', { method: 'POST', headers: { 'content-type': 'application/json' }, body })
    .then(() => undefined)
    .catch(() => undefined);
}

export default function PortalError({ error }: { error: Error & { digest?: string }; reset: () => void }) {
  const { t } = useSession();
  const pathname = usePathname();
  useEffect(() => {
    void reportClientError(pathname ?? '', error);
  }, [error, pathname]);
  return (
    <section className="card" data-testid="page-error">
      <p role="alert">{t('error_page_sentence')}</p>
      <button className="btn accent" type="button" onClick={() => window.location.reload()}>
        {t('error_page_reload')}
      </button>
    </section>
  );
}
