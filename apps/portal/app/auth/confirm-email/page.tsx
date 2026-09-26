'use client';

/*
 * THE SIGN-IN MOVES WHEN THE NEW ADDRESS PRESSES THE BUTTON (Brian, 2026-09-26, R45).
 *
 * Staff changed the contact email and accepted the offer to move the portal sign-in with it; one
 * confirmation link came to the NEW address, and this is its page. Like /auth/verify (the R37 rule),
 * the link is spent by a PRESS, never by the load: a mail scanner, a preview or a tap that closed
 * early changes nothing. Until the button is pressed the client keeps signing in with the previous
 * email. No session is needed here — holding the link in the new inbox is the proof.
 */
import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { api, ApiError } from '../../../lib/api';
import { useSession } from '../../../lib/session';

function ConfirmEmailInner() {
  const { t } = useSession();
  const params = useSearchParams();
  const token = params.get('token');
  const [state, setState] = useState<'ready' | 'working' | 'done' | 'failed'>(token ? 'ready' : 'failed');
  // The server's refusal, verbatim, when it has one; the dictionary's sentence otherwise.
  const [failure, setFailure] = useState<string | null>(null);

  const press = async () => {
    if (!token) return;
    setState('working');
    try {
      await api<{ moved: true }>('/portal/auth/email-change/confirm', { method: 'POST', body: { token } });
      setState('done');
    } catch (err) {
      setFailure(err instanceof ApiError && err.code === 'portal_email_taken' ? err.message : null);
      setState('failed');
    }
  };

  return (
    <div className="card" style={{ maxWidth: 420, margin: '40px auto', textAlign: 'center' }}>
      {state === 'failed' ? (
        <>
          <p className="alert error" role="alert">{failure ?? t('confirm_email_failed')}</p>
          <Link className="btn" href="/login">
            {t('login_title')}
          </Link>
        </>
      ) : state === 'working' ? (
        <p>{t('confirm_email_working')}</p>
      ) : state === 'done' ? (
        <>
          <p className="alert ok" data-testid="confirm-email-done">{t('confirm_email_done')}</p>
          <Link className="btn block" href="/login">
            {t('login_title')}
          </Link>
        </>
      ) : (
        <>
          <h1>{t('confirm_email_title')}</h1>
          <p className="muted">{t('confirm_email_intro')}</p>
          <button type="button" className="btn block" data-testid="confirm-email-press" onClick={() => void press()}>
            {t('confirm_email_press')}
          </button>
        </>
      )}
    </div>
  );
}

export default function ConfirmEmailPage() {
  return (
    <Suspense>
      <ConfirmEmailInner />
    </Suspense>
  );
}
