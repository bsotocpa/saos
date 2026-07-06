'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { api, setToken } from '../../../lib/api';
import { useSession } from '../../../lib/session';

function VerifyInner() {
  const { t, refresh } = useSession();
  const params = useSearchParams();
  const router = useRouter();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const token = params.get('token');
    if (!token) {
      setFailed(true);
      return;
    }
    void (async () => {
      try {
        const res = await api<{ token: string; firstLogin: boolean }>('/portal/auth/magic/verify', {
          method: 'POST',
          body: { token },
        });
        setToken(res.token);
        await refresh();
        router.replace('/');
      } catch {
        setFailed(true);
      }
    })();
  }, [params, router, refresh]);

  return (
    <div className="card" style={{ maxWidth: 420, margin: '40px auto', textAlign: 'center' }}>
      {failed ? (
        <>
          <p className="alert error">{t('verify_failed')}</p>
          <Link className="btn" href="/login">
            {t('login_title')}
          </Link>
        </>
      ) : (
        <p>{t('verify_working')}</p>
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
