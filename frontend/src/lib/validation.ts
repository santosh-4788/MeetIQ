const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/
const EMPLOYEE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9-/]{2,19}$/

export function validateLoginId(value: string): string | undefined {
  const v = value.trim()
  if (!v) return 'Enter your official email or employee ID.'
  if (v.includes('@')) return EMAIL_RE.test(v) ? undefined : 'Enter a valid email address.'
  return EMPLOYEE_ID_RE.test(v) ? undefined : 'Enter a valid employee ID (e.g. OIC-1001).'
}

// Mirrors the server-side policy (the server is authoritative; ASVS L2 V2.1).
export const passwordRules = [
  { id: 'len', label: 'At least 12 characters', test: (p: string) => p.length >= 12 },
  { id: 'upper', label: 'An uppercase letter', test: (p: string) => /[A-Z]/.test(p) },
  { id: 'lower', label: 'A lowercase letter', test: (p: string) => /[a-z]/.test(p) },
  { id: 'digit', label: 'A number', test: (p: string) => /\d/.test(p) },
  { id: 'symbol', label: 'A symbol (e.g. ! @ # $)', test: (p: string) => /[^A-Za-z0-9]/.test(p) },
] as const

export function passwordStrength(p: string) {
  const passed = passwordRules.filter((r) => r.test(p)).length
  const score = !p ? 0 : passed <= 2 ? 1 : passed <= 4 ? 2 : p.length >= 16 ? 4 : 3
  return { score, label: ['', 'Weak', 'Fair', 'Strong', 'Very strong'][score], valid: passed === passwordRules.length }
}
