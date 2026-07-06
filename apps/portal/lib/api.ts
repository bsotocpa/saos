// API access: same-origin /api/* (Next rewrite → Fastify). Bearer session
// token lives in sessionStorage for Phase 1 dev; the M21 hardening pass moves
// it to an httpOnly-cookie BFF pattern before production.

const TOKEN_KEY = 'saos_portal_token';

export function getToken(): string | null {
  return typeof window === 'undefined' ? null : window.sessionStorage.getItem(TOKEN_KEY);
}
export function setToken(token: string): void {
  window.sessionStorage.setItem(TOKEN_KEY, token);
}
export function clearToken(): void {
  window.sessionStorage.removeItem(TOKEN_KEY);
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
  if (res.status === 401 && !path.startsWith('/portal/auth/')) {
    clearToken();
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
