// Minimal SQL access to the LOCAL E2E database through sqlcmd (Windows authentication). No extra npm dependencies.
import { execFileSync } from 'node:child_process'
import { DB_NAME, DB_SERVER } from './config.mjs'

function sqlcmd(query, extra = []) {
  return execFileSync('sqlcmd', ['-S', DB_SERVER, '-d', DB_NAME, '-E', '-b', '-I', ...extra, '-Q', `SET NOCOUNT ON; ${query.replace(/\s*\r?\n\s*/g, ' ')}`], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
}

/** Runs a statement that returns nothing. */
export function exec(query) {
  sqlcmd(query)
}

/** Runs a SELECT and returns its rows (as JSON objects). */
export function query(select) {
  // -y 0: unlimited nvarchar(max) width (FOR JSON output); any header lines before the JSON are skipped.
  const lines = sqlcmd(`SELECT (SELECT * FROM (${select}) q FOR JSON PATH, INCLUDE_NULL_VALUES) AS j`, ['-y', '0']).split(/\r?\n/)
  const start = lines.findIndex((l) => l.startsWith('[') || l.trim() === 'NULL')
  const out = start < 0 ? '' : lines.slice(start).join('').trim()
  if (!out || out === 'NULL') return []
  return JSON.parse(out)
}

export function scalar(select) {
  const rows = query(select)
  if (!rows.length) return null
  return Object.values(rows[0])[0]
}

/** SQL string literal. */
export const q = (s) => (s === null || s === undefined ? 'NULL' : `N'${String(s).replace(/'/g, "''")}'`)
