'use client';

// Staff login: password + TOTP required (WISP). First login walks through
// MFA enrollment — no full session exists until the authenticator is proven.

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, markAuthed } from '../../lib/api';

type Phase = 'credentials' | 'enroll' | 'verify';

export default function LoginPage() {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>('credentials');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [setupToken, setSetupToken] = useState('');
  const [secret, setSecret] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const login = async () => {
    setBusy(true);
    setError('');
    try {
      const res = await api<{ status?: string; setupToken?: string; mustChangePassword?: boolean }>('/auth/login', {
        method: 'POST',
        body: { email, password, ...(totp ? { totp } : {}) },
      });
      if (res.status === 'ok') {
        // The session itself arrived as an httpOnly cookie. A first sign-in owes a password.
        markAuthed();
        router.push(res.mustChangePassword ? '/account?set-password=1' : '/');
      } else if (res.status === 'mfa_setup_required' && res.setupToken) {
        setSetupToken(res.setupToken);
        const setup = await api<{ secret: string }>('/auth/mfa/setup', {
          method: 'POST',
          body: { setupToken: res.setupToken },
        });
        setSecret(setup.secret);
        setPhase('enroll');
      }
    } catch (err) {
      const code = (err as { code?: string }).code;
      setError(code === 'totp_required' ? 'Enter your 6-digit authenticator code.' : 'Sign-in failed — check your credentials.');
    } finally {
      setBusy(false);
    }
  };

  const verifyEnrollment = async () => {
    setBusy(true);
    setError('');
    try {
      const verified = await api<{ mustChangePassword?: boolean }>('/auth/mfa/verify', {
        method: 'POST',
        body: { setupToken, code: totp },
      });
      markAuthed();
      if (verified.mustChangePassword) { router.push('/account?set-password=1'); return; }
      router.push('/');
    } catch {
      setError('Code did not match — try the next one from your app.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card" style={{ maxWidth: 400, margin: '48px auto' }}>
      <h1>Staff sign-in</h1>
      {error ? <p className="alert error">{error}</p> : null}

      {phase === 'credentials' ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void login();
          }}
        >
          <label className="field">
            Email
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </label>
          <label className="field">
            Password
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </label>
          <label className="field">
            Authenticator code (if enrolled)
            <input value={totp} onChange={(e) => setTotp(e.target.value)} placeholder="123456" inputMode="numeric" />
          </label>
          <button className="btn" type="submit" disabled={busy}>
            Sign in
          </button>
        </form>
      ) : (
        <div>
          <p className="alert info">
            MFA is required for all staff accounts. Add this secret to your authenticator app (or scan it as a
            manual entry), then confirm with a code.
          </p>
          <p className="small" style={{ wordBreak: 'break-all' }}>
            Secret: <strong data-testid="totp-secret">{secret}</strong>
          </p>
          <label className="field">
            Code from your authenticator
            <input value={totp} onChange={(e) => setTotp(e.target.value)} placeholder="123456" inputMode="numeric" data-testid="enroll-code" />
          </label>
          <button className="btn accent" type="button" disabled={busy} onClick={() => void verifyEnrollment()}>
            Enable MFA + sign in
          </button>
        </div>
      )}
    </div>
  );
}
