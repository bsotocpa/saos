'use client';

// Staff login: password + TOTP required (WISP). First login walks through
// MFA enrollment — no full session exists until the authenticator is proven.

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, markAuthed } from '../../lib/api';

// 'codes' (R65, 2026-09-26): the recovery codes, shown once after enrolment, held until "I saved these".
type Phase = 'credentials' | 'enroll' | 'verify' | 'codes';

/** Six digits is the authenticator; letters and digits (with or without the hyphen) is a recovery code. */
const isTotpShape = (s: string) => /^\d{6}$/.test(s.trim());

export default function LoginPage() {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>('credentials');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [setupToken, setSetupToken] = useState('');
  const [secret, setSecret] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [owesPassword, setOwesPassword] = useState(false);
  // THE ERROR STAYS WITH THE FIELD (Brian, 2026-09-19, defect 2): the server's refusal, verbatim,
  // under the field it is about — or under the button when it is about the attempt as a whole.
  const [inlineErr, setInlineErr] = useState<{ key: string; message: string } | null>(null);
  const errAt = (key: string) => (inlineErr?.key === key ? <p className="field-error" role="alert">{inlineErr.message}</p> : null);
  const refused = (err: unknown) => (err instanceof Error && err.message ? err.message : 'The request was refused.');
  const [busy, setBusy] = useState(false);

  /*
   * WHERE A SIGN-IN LANDS (R64, 2026-09-26): the role's home, as GET /auth/me computes it from the
   * session's permissions — My Queue for a preparer, the Executive view for the CEO. A first sign-in
   * still owes a password first. If the session cannot be read the root decides (the shell sends a
   * non-executive session on from there).
   */
  const landHome = async (mustChangePassword: boolean | undefined) => {
    if (mustChangePassword) { router.push('/account?set-password=1'); return; }
    const me = await api<{ home?: string }>('/auth/me').catch(() => null);
    router.push(me?.home ?? '/');
  };

  const login = async () => {
    setBusy(true);
    setInlineErr(null);
    try {
      const res = await api<{ status?: string; setupToken?: string; mustChangePassword?: boolean }>('/auth/login', {
        method: 'POST',
        // One field, two shapes (R65): a six-digit TOTP, or a recovery code in its place.
        body: { email, password, ...(totp.trim() ? (isTotpShape(totp) ? { totp: totp.trim() } : { recoveryCode: totp.trim() }) : {}) },
      });
      if (res.status === 'ok') {
        // The session itself arrived as an httpOnly cookie. A first sign-in owes a password.
        markAuthed();
        await landHome(res.mustChangePassword);
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
      setInlineErr({ key: code === 'totp_required' ? 'totp' : 'signin', message: refused(err) });
    } finally {
      setBusy(false);
    }
  };

  const verifyEnrollment = async () => {
    setBusy(true);
    setInlineErr(null);
    try {
      const verified = await api<{ mustChangePassword?: boolean; recoveryCodes?: string[] }>('/auth/mfa/verify', {
        method: 'POST',
        body: { setupToken, code: totp },
      });
      // The recovery codes are shown once, here, and the session waits for "I saved these" (R65).
      setRecoveryCodes(verified.recoveryCodes ?? []);
      setOwesPassword(Boolean(verified.mustChangePassword));
      setPhase('codes');
    } catch (err) {
      setInlineErr({ key: 'code', message: refused(err) });
    } finally {
      setBusy(false);
    }
  };

  const savedCodes = async () => {
    setBusy(true);
    try {
      markAuthed();
      await landHome(owesPassword);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card" style={{ maxWidth: 400, margin: '48px auto' }}>
      <h1>Staff sign-in</h1>

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
            Authenticator code or recovery code (if enrolled)
            <input value={totp} onChange={(e) => setTotp(e.target.value)} placeholder="123456 or XXXX-XXXX" autoComplete="one-time-code" />
            {errAt('totp')}
          </label>
          <button className="btn" type="submit" disabled={busy}>
            Sign in
          </button>
          {errAt('signin')}
        </form>
      ) : phase === 'codes' ? (
        <div data-testid="recovery-codes-panel">
          <p className="alert info">
            MFA is on. These are your recovery codes: each signs you in once if your authenticator is not to
            hand. They are shown only now. Save them somewhere safe, then continue.
          </p>
          <ul className="list" data-testid="recovery-codes" style={{ fontFamily: 'ui-monospace, monospace', fontSize: 16 }}>
            {recoveryCodes.map((c) => (
              <li key={c}><code>{c}</code></li>
            ))}
          </ul>
          <p className="muted small">A new set can be issued from Account at any time; issuing one replaces these.</p>
          <button className="btn accent" type="button" disabled={busy} onClick={() => void savedCodes()}>
            I saved these
          </button>
        </div>
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
            {errAt('code')}
          </label>
          <button className="btn accent" type="button" disabled={busy} onClick={() => void verifyEnrollment()}>
            Enable MFA + sign in
          </button>
        </div>
      )}
    </div>
  );
}
