// Staff API access (M21 hardening): the session token lives in an httpOnly
// cookie set by the API and travels automatically on the same-origin /api
// rewrite — page JavaScript never sees it. sessionStorage holds only a
// non-sensitive "signed in" marker for shell/nav state.

const AUTHED_KEY = 'saos_staff_authed';

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
    await api('/auth/logout', { method: 'POST' });
  } catch {
    /* session already dead — fine */
  }
  clearAuthed();
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
  if (res.status === 401 && !path.startsWith('/auth/')) {
    clearAuthed();
    window.location.href = '/login';
    throw new Error('session expired');
  }
  const json = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
  if (!res.ok) throw Object.assign(new Error(json.message ?? 'request failed'), { code: json.error, status: res.status, payload: json });
  return json as T;
}

export function formatMoney(cents: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
}
