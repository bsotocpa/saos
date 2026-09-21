'use client';

/*
 * THE SIGN-IN LINK IS REDEEMED BY A PRESS, NOT BY A LOAD (2026-09-20). This page used to POST the
 * token the moment it mounted, so anything that opened the link consumed it: a mail scanner that
 * runs page JavaScript, a preview, a tap that closed before the redirect. The person then got
 * "invalid, used, or expired" on a link they never used. Now the page draws one button and the
 * link is spent only when it is pressed. A bare GET, with or without JavaScript, changes nothing.
 */
import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { api, markAuthed } from '../../../lib/api';
import { useSession } from '../../../lib/session';

function VerifyInner() {
  const { t, refresh } = useSession();
  const params = useSearchParams();
  const router = useRouter();
  const token = params.get('token');
  const [state, setState] = useState<'ready' | 'working' | 'failed'>(token ? 'ready' : 'failed');

  const press = async () => {
    if (!token) return;
    setState('working');
    try {
      await api<{ firstLogin: boolean }>('/portal/auth/magic/verify', {
        method: 'POST',
        body: { token },
      });
      // The session itself arrived as an httpOnly cookie.
      markAuthed();
      await refresh();
      router.replace('/');
    } catch {
      setState('failed');
    }
  };

  return (
    <div className="card" style={{ maxWidth: 420, margin: '40px auto', textAlign: 'center' }}>
      {state === 'failed' ? (
        <>
          <p className="alert error">{t('verify_failed')}</p>
          <Link className="btn" href="/login">
            {t('login_title')}
          </Link>
        </>
      ) : state === 'working' ? (
        <p>{t('verify_working')}</p>
      ) : (
        <>
          <h1>{t('login_title')}</h1>
          <p className="muted">{t('verify_intro')}</p>
          <button type="button" className="btn block" data-testid="verify-press" onClick={() => void press()}>
            {t('verify_press')}
          </button>
        </>
      )}
    </div>
  );
}

export default function VerifyPage() {
  return (
    <Suspense>
      <VerifyInner />
    </Suspense>
  );
}
