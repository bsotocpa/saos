'use client';

import { useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { useSession } from '../../lib/session';

export default function LoginPage() {
  const { t } = useSession();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  return (
    <div className="card" style={{ maxWidth: 420, margin: '40px auto' }}>
      <h1>{t('login_title')}</h1>
      {sent ? (
        <p className="alert info">{t('login_sent')}</p>
      ) : (
        <>
          <p className="muted">
            {t('login_intro')} {t('login_same_address')}
          </p>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError('');
              try {
                await api('/portal/auth/magic/request', { method: 'POST', body: { email } });
                setSent(true);
              } catch (err) {
                // The server's message, verbatim, at the field; the address stays typed.
                setError(err instanceof ApiError ? err.message : t('error_generic'));
              } finally {
                setBusy(false);
              }
            }}
          >
            <label className="field">
              {t('login_email')}
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required aria-invalid={error ? true : undefined} />
            </label>
            {error ? <p className="field-error" role="alert">{error}</p> : null}
            <button className="btn block" type="submit" disabled={busy}>
              {t('login_send')}
            </button>
          </form>
        </>
      )}
    </div>
  );
}
