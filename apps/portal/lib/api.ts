// API access (M21 hardening): same-origin /api/* (Next rewrite → Fastify).
// The session token lives in an httpOnly cookie set by the API — page
// JavaScript never sees it. sessionStorage holds only a non-sensitive
// "signed in" marker for shell/nav state.

const AUTHED_KEY = 'saos_portal_authed';

export function isAuthed(): boolean {
  return typeof window !== 'undefined' && window.sessionStorage.getItem(AUTHED_KEY) === '1';
}
export function markAuthed(): void {
  window.sessionStorage.setItem(AUTHED_KEY, '1');
}
export function clearAuthed(): void {
  window.sessionStorage.removeItem(AUTHED_KEY);
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
