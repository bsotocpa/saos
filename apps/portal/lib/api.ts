// API access (M21 hardening): same-origin /api/* (Next rewrite → Fastify).
// The session token lives in an httpOnly cookie set by the API — page
// JavaScript never sees it. Local storage holds only a non-sensitive
// "signed in" marker for shell/nav state.
//
// FINDING #13 — this marker was in sessionStorage, which iPhone Safari clears when the
// tab closes. The SESSION itself did not end: the cookie carries maxAge = 30 days and
// the server checks expiry and revocation on every request. So a client closed the tab,
// came back with a perfectly valid session, and was bounced to the login screen by a
// hint that had evaporated. The portal looked like it required a fresh magic link every
// visit while actually keeping them signed in for a month.
//
// localStorage survives tab close, which matches the cookie it is a hint about. It is
// only ever a hint: if it is stale — cookie expired, session revoked, access removed —
// the first API call returns 401 and the app sends them to sign in. Nothing is trusted
// on the client side, so the worst a wrong marker costs is one redirect.

const AUTHED_KEY = 'saos_portal_authed';

function store(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    // Safari private mode can throw on access rather than returning null.
    return null;
  }
}

export function isAuthed(): boolean {
  const s = store();
  if (!s) return false;
  if (s.getItem(AUTHED_KEY) === '1') return true;
  // One-time carry-over for anyone still holding the old sessionStorage marker, so the
  // fix does not sign out the people it is meant to keep signed in.
  try {
    if (window.sessionStorage.getItem(AUTHED_KEY) === '1') {
      s.setItem(AUTHED_KEY, '1');
      return true;
    }
  } catch {
    /* no sessionStorage either — treat as signed out */
  }
  return false;
}
export function markAuthed(): void {
  store()?.setItem(AUTHED_KEY, '1');
}
export function clearAuthed(): void {
  store()?.removeItem(AUTHED_KEY);
  try {
    window.sessionStorage.removeItem(AUTHED_KEY);
  } catch {
    /* nothing to clear */
  }
}

/** Server-side sign-out: revokes the session and clears the cookie. */
export async function signOut(): Promise<void> {
  try {
    await api('/portal/auth/logout', { method: 'POST' });
  } catch {
    /* session already dead — fine */
  }
  clearAuthed();
}

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function api<T>(
  path: string,
  opts: { method?: string; body?: unknown; formData?: FormData } = {}
): Promise<T> {
  const headers: Record<string, string> = {};
  let body: BodyInit | undefined;
  if (opts.formData) {
    body = opts.formData;
  } else if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  const res = await fetch(`/api${path}`, { method: opts.method ?? 'GET', headers, ...(body !== undefined ? { body } : {}) });
  if (res.status === 401 && !path.startsWith('/portal/auth/')) {
    clearAuthed();
    window.location.href = '/login';
    throw new ApiError(401, 'unauthorized', 'Session expired');
  }
  const json = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
  if (!res.ok) {
    throw new ApiError(res.status, json.error ?? 'error', json.message ?? 'Request failed');
  }
  return json as T;
}

export function formatMoney(cents: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
}
