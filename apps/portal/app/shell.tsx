'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { isAuthed, signOut } from '../lib/api';
import { useSession } from '../lib/session';

const NAV: Array<{ href: string; key: 'nav_home' | 'nav_documents' | 'nav_returns' | 'nav_notices' | 'nav_sign' | 'nav_invoices' | 'nav_messages' | 'nav_estimate' | 'nav_resources' | 'nav_profile' }> = [
  { href: '/', key: 'nav_home' },
  { href: '/documents', key: 'nav_documents' },
  { href: '/returns', key: 'nav_returns' },
  { href: '/notices', key: 'nav_notices' },
  { href: '/sign', key: 'nav_sign' },
  { href: '/invoices', key: 'nav_invoices' },
  { href: '/messages', key: 'nav_messages' },
  { href: '/estimate', key: 'nav_estimate' },
  { href: '/resources', key: 'nav_resources' },
  { href: '/profile', key: 'nav_profile' },
];

export function Shell({ children }: { children: ReactNode }) {
  const { t, lang, setLang } = useSession();
  const pathname = usePathname();
  const router = useRouter();
  // Auth state resolves in an effect: the server always renders the
  // unauthenticated shell, so hydration never mismatches.
  const [authed, setAuthed] = useState(false);
  useEffect(() => {
    setAuthed(isAuthed());
  }, [pathname]);

  return (
    <>
      <header className="topbar">
        <Link href="/" className="wordmark">
          SOTO<span className="dot">.</span>
        </Link>
        <span className="spacer" />
        <button
          type="button"
          className="lang-toggle"
          data-testid="lang-toggle"
          onClick={() => setLang(lang === 'en' ? 'es' : 'en')}
          aria-label="Language toggle"
        >
          {lang === 'en' ? 'Español' : 'English'}
        </button>
        {authed ? (
          <button
            type="button"
            className="lang-toggle"
            data-testid="sign-out"
            onClick={() => {
              void signOut().then(() => router.push('/login'));
            }}
          >
            {t('sign_out')}
          </button>
        ) : null}
      </header>
      {/*
        §7216 CONSENT SCREEN ISOLATION (Rev. Proc. 2013-14, launch-gate tier).
        An electronic §7216 consent must be presented on a screen whose content
        pertains SOLELY to the consent. The site nav is other content, so it is
        suppressed on /consent — the client can still sign out and switch language
        from the topbar, but nothing invites them elsewhere mid-decision.
        Do not "fix" this by adding the nav back.
      */}
      {authed && !pathname.startsWith('/consent') ? (
        <nav className="nav">
          {NAV.map((item) => (
            <Link key={item.href} href={item.href} className={pathname === item.href ? 'active' : ''}>
              {t(item.key)}
            </Link>
          ))}
        </nav>
      ) : null}
      <main>{children}</main>
    </>
  );
}
