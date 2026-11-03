// Node API client for seeding and for checks that complement the browser tests. Talks to the ISOLATED API only.
import { API } from './config.mjs'

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0' // the ASP.NET Core development certificate on localhost

export class ApiClient {
  constructor() {
    this.cookies = new Map()
  }

  cookieHeader() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ')
  }

  async request(method, path, body) {
    if (method !== 'GET' && !this.cookies.has('XSRF-TOKEN')) await this.request('GET', '/health')
    const headers = { Accept: 'application/json' }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    if (this.cookies.size) headers.Cookie = this.cookieHeader()
    if (method !== 'GET') headers['X-XSRF-TOKEN'] = decodeURIComponent(this.cookies.get('XSRF-TOKEN') ?? '')
    const res = await fetch(`${API}/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair] = c.split(';')
      const i = pair.indexOf('=')
      const name = pair.slice(0, i).trim()
      const value = pair.slice(i + 1).trim()
      if (/expires=Thu, 01 Jan 1970/i.test(c) || value === '') this.cookies.delete(name)
      else this.cookies.set(name, value)
    }
    const text = await res.text()
    let data = null
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      data = text
    }
    return { status: res.status, data }
  }

  get = (p) => this.request('GET', p)
  post = (p, b) => this.request('POST', p, b)
  put = (p, b) => this.request('PUT', p, b)
  del = (p) => this.request('DELETE', p)

  /** Asserts a 2xx status and returns the body. */
  async ok(method, path, body) {
    const r = await this.request(method, path, body)
    if (r.status < 200 || r.status >= 300) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(r.data)}`)
    return r.data
  }

  async login(login, password) {
    const r = await this.post('/auth/login', { login, password, rememberMe: false })
    if (r.status !== 200) throw new Error(`login ${login} -> ${r.status} ${JSON.stringify(r.data)}`)
    return r.data
  }
}

export async function signedIn(login, password) {
  const c = new ApiClient()
  await c.login(login, password)
  return c
}
