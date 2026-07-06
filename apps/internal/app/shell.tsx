'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { clearToken, getToken } from '../lib/api';

const NAV = [
  { href: '/', label: 'Executive' },
  { href: '/hilo', label: 'Hilo Ops' },
  { href: '/alerts', label: 'Alerts' },
  { href: '/upload-return', label: 'Deliver Return' },
  { href: '/recorder', label: 'Recorder' },
];

export function Shell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [authed, setAuthed] = useState(false);
  useEffect(() => {
    setAuthed(Boolean(getToken()));
  }, [pathname]);

  return (
    <>
      <header className="topbar">
        <Link href="/" className="wordmark">
          SOTO<span className="dot">.</span>
          <span className="sub">OPERATIONS</span>
        </Link>
        <span className="spacer" />
        {authed ? (
          <button
            type="button"
            data-testid="sign-out"
            onClick={() => {
              clearToken();
              router.push('/login');
            }}
          >
            Sign out
          </button>
        ) : null}
      </header>
      {authed ? (
        <nav className="nav">
          {NAV.map((item) => (
            <Link key={item.href} href={item.href} className={pathname === item.href ? 'active' : ''}>
              {item.label}
            </Link>
          ))}
        </nav>
      ) : null}
      <main>{children}</main>
    </>
  );
}
