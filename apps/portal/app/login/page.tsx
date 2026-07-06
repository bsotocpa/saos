'use client';

import { useState } from 'react';
import { api } from '../../lib/api';
import { useSession } from '../../lib/session';

export default function LoginPage() {
  const { t } = useSession();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  return (
    <div className="card" style={{ maxWidth: 420, margin: '40px auto' }}>
      <h1>{t('login_title')}</h1>
      {sent ? (
        <p className="alert info">{t('login_sent')}</p>
      ) : (
        <>
          <p className="muted">{t('login_intro')}</p>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              try {
                await api('/portal/auth/magic/request', { method: 'POST', body: { email } });
                setSent(true);
              } finally {
                setBusy(false);
              }
            }}
          >
            <label className="field">
              {t('login_email')}
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </label>
            <button className="btn block" type="submit" disabled={busy}>
              {t('login_send')}
            </button>
          </form>
        </>
      )}
    </div>
  );
}
