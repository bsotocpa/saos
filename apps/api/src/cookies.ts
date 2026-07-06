// Session cookies (M21 hardening). Both apps reach the API through their own
// origin (Next /api rewrite), so the session token travels in a FIRST-PARTY
// httpOnly cookie — JavaScript (and therefore any injected script) can never
// read it. The Authorization: Bearer header remains accepted for
// programmatic clients and the test suite.
//
// CSRF posture: SameSite=Lax blocks cross-site sends of the cookie on
// POST/PATCH/DELETE (including form and multipart posts); state-changing
// routes additionally only parse JSON bodies, which cross-site forms cannot
// produce. No urlencoded parser is registered.

import type { CookieSerializeOptions } from '@fastify/cookie';
import type { Config } from './config.ts';

export const STAFF_SESSION_COOKIE = 'saos_staff_session';
export const PORTAL_SESSION_COOKIE = 'saos_portal_session';

function base(config: Config): CookieSerializeOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    // Dev serves plain http on localhost; staging/production sit behind TLS.
    secure: config.NODE_ENV === 'production',
  };
}

/** Staff cookie lives at most the absolute session lifetime; the sliding idle window is enforced server-side. */
export function staffCookieOptions(config: Config): CookieSerializeOptions {
  return { ...base(config), maxAge: config.SESSION_ABSOLUTE_HOURS * 3600 };
}

export function portalCookieOptions(config: Config): CookieSerializeOptions {
  return { ...base(config), maxAge: config.PORTAL_SESSION_DAYS * 86400 };
}

/** For clearing: same attributes, no maxAge (clearCookie requires matching path). */
export function clearCookieOptions(config: Config): CookieSerializeOptions {
  return base(config);
}
