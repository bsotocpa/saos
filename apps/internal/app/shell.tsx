'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { api, isAuthed, signOut } from '../lib/api';
import { visibleNav } from '../lib/nav';
import { HydratedFieldset } from '../components/hydrated-fieldset';

/*
 * WHO IS SIGNED IN, ONCE PER SESSION (R64, 2026-09-26). The navigation shows only the pages this
 * session can open and the root sends a non-executive session to its home, both decided from
 * GET /auth/me — the permissions and the `home` the API computed from them. The answer is cached
 * for the signed-in session (one call, not one per page) and dropped on sign-out, so a new sign-in
 * in the same tab asks again.
 */
interface Me { permissions: string[]; home: string }
let mePromise: Promise<Me> | null = null;
function loadMe(): Promise<Me> {
  mePromise ??= api<Me>('/auth/me').catch((e: unknown) => { mePromise = null; throw e; });
  return mePromise;
}
/** Exported for the sign-out button and for tests that need a fresh answer. */
export function forgetMe(): void { mePromise = null; }

export function Shell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [authed, setAuthed] = useState(false);
  const [me, setMe] = useState<Me | null>(null);
  useEffect(() => {
    const now = isAuthed();
    setAuthed(now);
    if (!now) { forgetMe(); setMe(null); return; }
    let alive = true;
    // A session the API refuses (401 sends itself to /login inside api()) leaves the navigation empty
    // rather than showing pages it could not open; Account is always reachable from the wordmark.
    loadMe().then((m) => { if (alive) setMe(m); }).catch(() => { if (alive) setMe({ permissions: [], home: '/account' }); });
    return () => { alive = false; };
  }, [pathname]);

  // The root is the Executive view. A session whose home is elsewhere is sent there before the
  // page renders, so nobody lands on a page that hangs on a refusal.
  const redirecting = authed && pathname === '/' && me !== null && me.home !== '/';
  useEffect(() => {
    if (redirecting && me) router.replace(me.home);
  }, [redirecting, me, router]);

  const items = me ? visibleNav(me.permissions) : [];

  return (
    <>
      <header className="topbar">
        <Link href={me?.home ?? '/'} className="wordmark">
          SOTO<span className="dot">.</span>
          <span className="sub">OPERATIONS</span>
        </Link>
        <span className="spacer" />
        {authed ? (
          <button
            type="button"
            data-testid="sign-out"
            onClick={() => {
              forgetMe();
              void signOut().then(() => router.push('/login'));
            }}
          >
            Sign out
          </button>
        ) : null}
      </header>
      {authed ? (
        <nav className="nav" data-testid="top-nav" data-ready={me ? 'yes' : 'no'}>
          {items.map((item) => (
            <Link key={item.href} href={item.href} className={pathname === item.href ? 'active' : ''}>
              {item.label}
            </Link>
          ))}
        </nav>
      ) : null}
      {/* EVERY PAGE WAITS FOR REACT BEFORE IT TAKES TYPING (2026-09-29, receipt runs 34-36): the fieldset's
          effect runs after the whole page subtree has hydrated, so no field can be typed into and then reset
          by hydration: three walks lost a first field that way (sign-in, Add staff, Deliver Return). */}
      <main><HydratedFieldset>{redirecting || (authed && pathname === '/' && me === null) ? null : children}</HydratedFieldset></main>
    </>
  );
}
