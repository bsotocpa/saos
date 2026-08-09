'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { isAuthed, signOut } from '../lib/api';

const NAV = [
  { href: '/', label: 'Executive' },
  { href: '/tasks', label: 'My Tasks' },
  { href: '/inbox', label: 'Inbox' },
  { href: '/hilo', label: 'Hilo Ops' },
  { href: '/alerts', label: 'Alerts' },
  { href: '/upload-return', label: 'Deliver Return' },
  { href: '/recorder', label: 'Recorder' },
  { href: '/admin/pricing', label: 'Pricing' },
  { href: '/admin/templates', label: 'Templates' },
  { href: '/admin/staff', label: 'Staff' },
  { href: '/admin/settings', label: 'Settings' },
  { href: '/admin/wisp', label: 'WISP' },
  { href: '/account', label: 'Account' },
];

export function Shell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [authed, setAuthed] = useState(false);
  useEffect(() => {
    setAuthed(isAuthed());
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
              void signOut().then(() => router.push('/login'));
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
