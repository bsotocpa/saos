'use client';

// CAN-SPAM one-click unsubscribe. No account, no login, no confirmation step —
// the click in the email IS the request, and making someone sign in to stop
// hearing from us would be both non-compliant and rude.
//
// The page is explicit that this stops ANNOUNCEMENTS only: a client who thinks
// they have switched off "your return is ready" would be worse off, not better.

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { api } from '../../../../lib/api';
import { useSession } from '../../../../lib/session';

export default function UnsubscribePage() {
  const { t } = useSession();
  const params = useParams<{ id: string; token: string }>();
  const [state, setState] = useState<'working' | 'done' | 'invalid'>('working');

  useEffect(() => {
    void api(`/public/unsubscribe/${params.id}/${params.token}`, { method: 'POST' })
      .then(() => setState('done'))
      .catch(() => setState('invalid'));
  }, [params.id, params.token]);

  if (state === 'working') return <p className="muted">{t('loading')}</p>;

  if (state === 'invalid') {
    return (
      <section className="card">
        <h1>{t('unsub_invalid_title')}</h1>
        <p>{t('unsub_invalid_body')}</p>
      </section>
    );
  }

  return (
    <section className="card">
      <h1>{t('unsub_done_title')}</h1>
      <p>{t('unsub_done_body')}</p>
      <p className="muted small">{t('unsub_still_get')}</p>
      <p className="muted small">{t('unsub_undo')}</p>
    </section>
  );
}
