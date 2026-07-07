'use client';

// Account security: change your password (M4 endpoint — POST /auth/password).
// A successful change revokes every OTHER session; this one stays signed in.

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, isAuthed } from '../../lib/api';

export default function AccountPage() {
  const router = useRouter();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!isAuthed()) router.replace('/login');
  }, [router]);

  const submit = async () => {
    setError('');
    setMessage('');
    if (newPassword.length < 12) {
      setError('New password must be at least 12 characters.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('New passwords do not match.');
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
      const code = (err as { code?: string }).code;
      setError(code === 'unauthorized' || code === 'invalid_credentials'
        ? 'Current password did not match.'
        : 'Password change failed — try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card" style={{ maxWidth: 440 }}>
      <h1>Account security</h1>
      <p className="muted small">
        Changing your password signs out every other active session. Your authenticator (MFA)
        enrollment is unaffected.
      </p>
      {message ? <p className="alert info">{message}</p> : null}
      {error ? <p className="alert error">{error}</p> : null}
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
        </label>
        <button className="btn" type="submit" disabled={busy || !currentPassword || !newPassword}>
          Change password
        </button>
      </form>
    </div>
  );
}
