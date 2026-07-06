// Staff API access (bearer in sessionStorage — the M21 hardening pass moves
// both apps to httpOnly-cookie BFF before production).

const TOKEN_KEY = 'saos_staff_token';

export function getToken(): string | null {
  return typeof window === 'undefined' ? null : window.sessionStorage.getItem(TOKEN_KEY);
}
export function setToken(token: string): void {
  window.sessionStorage.setItem(TOKEN_KEY, token);
}
export function clearToken(): void {
  window.sessionStorage.removeItem(TOKEN_KEY);
}

export async function api<T>(
  path: string,
  opts: { method?: string; body?: unknown; formData?: FormData } = {}
): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;
  let body: BodyInit | undefined;
  if (opts.formData) {
    body = opts.formData;
  } else if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  const res = await fetch(`/api${path}`, { method: opts.method ?? 'GET', headers, ...(body !== undefined ? { body } : {}) });
  if (res.status === 401 && !path.startsWith('/auth/')) {
    clearToken();
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
