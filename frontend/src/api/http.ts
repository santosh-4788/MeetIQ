import { API_BASE } from '../config'
import { ApiError, type ApiErrorCode } from './types'

/** Window event fired when an API call reports that the session no longer exists (handled by AuthProvider). */
export const SESSION_ENDED = 'oic:session-ended'

function readCookie(name: string) {
  return document.cookie
    .split('; ')
    .find((c) => c.startsWith(`${name}=`))
    ?.split('=')[1]
}

/**
 * Same-origin JSON client. Auth uses the HttpOnly session cookie set by the API;
 * state-changing requests echo the antiforgery cookie as a header (ASP.NET Core antiforgery).
 */
export async function http<T>(path: string, init: { method?: string; body?: unknown; text?: boolean } = {}): Promise<T> {
  const method = init.method ?? 'GET'
  const headers: Record<string, string> = { Accept: init.text ? 'text/plain, text/csv, application/json' : 'application/json' }
  if (init.body !== undefined) headers['Content-Type'] = 'application/json'
  if (method !== 'GET') {
    const xsrf = readCookie('XSRF-TOKEN')
    if (xsrf) headers['X-XSRF-TOKEN'] = decodeURIComponent(xsrf)
  }

  let res: Response
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      credentials: 'same-origin',
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    })
  } catch {
    throw new ApiError(0, 'NETWORK', 'Unable to reach the OneInsure Connect server. Check your connection and try again.')
  }

  if (res.status === 204) return undefined as T
  // Plain-text downloads (e.g. the employee CSV template); errors are still problem JSON.
  if (init.text && res.ok) return (await res.text()) as T
  const data = await res.json().catch(() => null)
  if (res.ok) return data as T

  // A 5xx without the API's problem JSON comes from the reverse proxy (IIS / dev server) because the API itself is down
  // or restarting: say so instead of a generic "could not be completed".
  if (res.status >= 500 && !data?.code)
    throw new ApiError(res.status, 'NETWORK', 'Unable to reach the OneInsure Connect server. It may be restarting: please try again in a moment.')

  // ProblemDetails (RFC 9457) with an application "code" extension.
  const code = (data?.code as ApiErrorCode | undefined) ?? statusToCode(res.status)
  // The server ended the session (idle/absolute expiry, revoked elsewhere, account disabled): let the app sign out
  // instead of showing every page as broken. /auth/me answers 401 for anonymous visitors, which is not an expiry.
  if (res.status === 401 && code === 'UNAUTHORIZED' && path !== '/auth/me') window.dispatchEvent(new Event(SESSION_ENDED))
  throw new ApiError(res.status, code, data?.detail ?? data?.title ?? 'The request could not be completed.', data ?? {})
}

function statusToCode(status: number): ApiErrorCode {
  if (status === 401) return 'UNAUTHORIZED'
  if (status === 403) return 'FORBIDDEN'
  if (status === 423) return 'ACCOUNT_LOCKED'
  if (status === 429) return 'RATE_LIMITED'
  return 'SERVER'
}
