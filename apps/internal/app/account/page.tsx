'use client';

// Account security: change your password (M4 endpoint — POST /auth/password).
// A successful change revokes every OTHER session; this one stays signed in.

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, isAuthed } from '../../lib/api';

export default function AccountPage() {
  // Read after mount: useSearchParams needs a Suspense boundary at build time, and the harness builds for production.
  const [mustSet, setMustSet] = useState(false);
  useEffect(() => { setMustSet(new URLSearchParams(window.location.search).get('set-password') === '1'); }, []);
  const router = useRouter();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [message, setMessage] = useState('');
  // THE ERROR STAYS WITH THE FIELD (Brian, 2026-09-19, defect 2): keyed to the control that
  // caused it, the server's words verbatim, the typed text kept.
  const [inlineErr, setInlineErr] = useState<{ key: string; message: string } | null>(null);
  const errAt = (key: string) => (inlineErr?.key === key ? <p className="field-error" role="alert">{inlineErr.message}</p> : null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!isAuthed()) router.replace('/login');
  }, [router]);

  const submit = async () => {
    setInlineErr(null);
    setMessage('');
    if (newPassword.length < 12) {
      setInlineErr({ key: 'new', message: 'New password must be at least 12 characters.' });
      return;
    }
    if (newPassword !== confirmPassword) {
      setInlineErr({ key: 'confirm', message: 'New passwords do not match.' });
      return;
    }
    setBusy(true);
    try {
      await api('/auth/password', { method: 'POST', body: { currentPassword, newPassword } });
      setMessage('Password changed. Every other session has been signed out; this one stays active.');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err) {
      // A credentials refusal belongs to the current-password field; anything else, to the button.
      const code = (err as { code?: string }).code;
      const key = code === 'unauthorized' || code === 'invalid_credentials' ? 'current' : 'submit';
      setInlineErr({ key, message: err instanceof Error && err.message ? err.message : 'The request was refused.' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card" style={{ maxWidth: 440 }}>
      <h1>Account security</h1>
      {/* A first sign-in owes a password (2026-09-12): the temporary one is spent, and the API refuses everything but /auth until this is done. */}
      {mustSet ? <p className="alert warn" role="status">Set your own password to continue. The temporary one you signed in with is spent, and nothing else works until you do.</p> : null}
      <p className="muted small">
        Changing your password signs out every other active session. Your authenticator (MFA)
        enrollment is unaffected.
      </p>
      {message ? <p className="alert info">{message}</p> : null}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label className="field">
          Current password
          <input
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            required
          />
          {errAt('current')}
        </label>
        <label className="field">
          New password (12+ characters)
          <input
            type="password"
            autoComplete="new-password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            required
            minLength={12}
          />
          {errAt('new')}
        </label>
        <label className="field">
          Confirm new password
          <input
            type="password"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            required
            minLength={12}
          />
          {errAt('confirm')}
        </label>
        <button className="btn" type="submit" disabled={busy || !currentPassword || !newPassword}>
          Change password
        </button>
        {errAt('submit')}
      </form>
    </div>
  );
}
