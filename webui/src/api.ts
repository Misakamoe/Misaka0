import type { ActionResult, ErrorCode, Me } from '../../shared/schemas';
import { errorCodeSchema } from '../../shared/schemas';

export class ApiError extends Error {
  constructor(public code: ErrorCode, public fields: string[] = []) {
    super(code);
  }
}

let bearer: string | undefined;
let csrf: string | null = null;
let generation = 0;
const active = new Set<AbortController>();

export function clearSession() {
  bearer = undefined;
  csrf = null;
  generation += 1;
  for (const request of active) request.abort();
  active.clear();
}

export function establishSession(me: Me) {
  csrf = me.csrfToken;
}

export async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const controller = new AbortController();
  const started = generation;
  active.add(controller);
  const timeout = window.setTimeout(() => controller.abort(), 20_000);
  try {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    else if (csrf && method !== 'GET') headers['X-CSRF-Token'] = csrf;
    const response = await fetch(path, {
      method, headers, credentials: 'same-origin', cache: 'no-store',
      body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal,
    });
    if (started !== generation) throw new ApiError('CANCELLED');
    const data = response.status === 204 ? undefined : await response.json().catch(() => undefined);
    if (started !== generation) throw new ApiError('CANCELLED');
    if (!response.ok) {
      const parsed = errorCodeSchema.safeParse(data?.error?.code);
      const code = parsed.success ? parsed.data : response.status === 401 ? 'AUTH_EXPIRED' : 'UNAVAILABLE';
      if (response.status === 401 || response.status === 403 && code === 'FORBIDDEN' && data?.status === undefined) {
        clearSession();
        window.dispatchEvent(new Event('misaka:expired'));
      }
      throw new ApiError(code, Array.isArray(data?.error?.fields) ? data.error.fields : []);
    }
    if (response.status !== 204 && data === undefined) throw new ApiError('INVALID_OUTPUT');
    return data as T;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(started !== generation ? 'CANCELLED' : controller.signal.aborted ? 'TIMEOUT' : 'UNAVAILABLE');
  } finally {
    active.delete(controller);
    window.clearTimeout(timeout);
  }
}

export async function exchangeMiniApp(initData: string) {
  const result = await request<{ token: string; expiresAt: string }>('/auth/miniapp', 'POST', { initData });
  bearer = result.token;
}

export async function action<T>(path: string, method = 'GET', body?: unknown): Promise<ActionResult<T>> {
  const result = await request<ActionResult<T>>(path, method, body);
  if (result.status === 'rejected' || result.status === 'failed') {
    throw new ApiError(result.error.code, result.error.fields);
  }
  return result;
}

export async function query<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const result = await action<T>(path, method, body);
  if (result.status !== 'succeeded') throw new ApiError('CONFIRMATION_REQUIRED');
  return result.data;
}

export function errorCode(error: unknown): ErrorCode {
  return error instanceof ApiError ? error.code : 'INTERNAL_ERROR';
}
