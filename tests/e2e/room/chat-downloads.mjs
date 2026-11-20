// Chat attachment downloads (20 Nov 2026 fix): an Excel file whose name has spaces and brackets is saved with its real
// name and type in Chrome (computer), Chrome on Android, and Safari on iPhone (share sheet when available, else save link).
// Also checks the header against Android WebView's own file-name rule (URLUtil.guessFileName) used by the Android app.
// Isolated environment only. Run:  cd "E:\Beeinsured.com\MeetIQ\tests\e2e"; node room\chat-downloads.mjs
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { chromium, devices, webkit } from 'playwright-core'
setTimeout(() => { console.log('WATCHDOG'); process.exit(2) }, 8 * 60_000).unref()
import { Api, EMP, HOST, RESULTS, WEB, check, closeAll, exec, loginUI, scalar, sleep, tc, until, view, writeResults } from './harness.mjs'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const tag = Date.now().toString(36).slice(-5)
const NAME = `Sales Report (Nov) ${tag}.xlsx`
exec("UPDATE app.FeatureSettings SET IsEnabled = 1 WHERE FeatureKey IN ('CHAT','CHAT_CALLS','CHAT_TASKS','CHAT_ADVANCED')")
const ok = {}

// A real (tiny) .xlsx: stored zip with the minimum SpreadsheetML parts.
function zip(files) {
  const parts = [], central = []
  let offset = 0
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text, 'utf8'), n = Buffer.from(name, 'utf8'), crc = zlib.crc32(data)
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt32LE(crc, 14); h.writeUInt32LE(data.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(n.length, 26)
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt32LE(crc, 16); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(offset, 42)
    parts.push(h, n, data); central.push(c, n); offset += 30 + n.length + data.length
  }
  const cd = Buffer.concat(central), e = Buffer.alloc(22)
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(central.length / 2, 8); e.writeUInt16LE(central.length / 2, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(offset, 16)
  return Buffer.concat([...parts, cd, e])
}
const xlsx = zip({
  '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
  '_rels/.rels': '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
  'xl/workbook.xml': '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>',
  'xl/_rels/workbook.xml.rels': '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
  'xl/worksheets/sheet1.xml': '<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Premium</t></is></c></row></sheetData></worksheet>',
})
const dir = path.join(RESULTS, 'chat-files')
fs.mkdirSync(dir, { recursive: true })
const file = path.join(dir, NAME)
fs.writeFileSync(file, xlsx)

// Hema sends the file to Esha over the API (same upload the composer uses).
const hema = await new Api().login(HOST.email)
const esha = await new Api().login(EMP.email)
const eshaId = scalar(`SELECT CONVERT(varchar(40), u.PublicId) AS v FROM auth.Users u WHERE u.Email = '${EMP.email}'`)
let fileId, conv

ok.upload = await tc('DL-01', 'Excel file with spaces and brackets in its name is accepted and passes the virus check', 'upload → CLEAN', async () => {
  const people = await hema.req('GET', `/chat/people?search=${encodeURIComponent('Esha')}`)
  const person = (people.data?.items ?? people.data ?? []).find((p) => /Esha/.test(p.name))
  check(person, 'Esha not found in people')
  const started = await hema.req('POST', '/chat/direct', { userId: person.id })
  check(started.status === 200 || started.status === 201, `direct ${started.status}`)
  conv = started.data.id
  const form = new FormData()
  form.append('file', new Blob([xlsx]), NAME)
  form.append('clientMessageId', crypto.randomUUID())
  const headers = { Cookie: [...hema.jar].map(([k, v]) => `${k}=${v}`).join('; '), 'X-XSRF-TOKEN': decodeURIComponent(hema.jar.get('XSRF-TOKEN')) }
  const up = await fetch(`${WEB}/api/v1/chat/conversations/${conv}/files`, { method: 'POST', headers, body: form })
  check(up.ok, `upload ${up.status} ${await up.text()}`)
  await until(() => scalar(`SELECT TOP 1 ScanStatus AS v FROM chat.TRN_ChatFile WHERE OriginalName = N'${NAME}'`) === 'CLEAN', 'not scanned clean', 60_000)
  fileId = scalar(`SELECT TOP 1 CONVERT(varchar(40), PublicId) AS v FROM chat.TRN_ChatFile WHERE OriginalName = N'${NAME}'`)
  return `file ${fileId}`
})

ok.header = ok.upload && await tc('DL-02', 'Download headers: real Excel type, and a file name the Android app can read', 'Content-Type = spreadsheet; Android URLUtil rule gives the real name', async () => {
  const r = await fetch(`${WEB}/api/v1/chat/files/${fileId}`, { headers: { Cookie: [...esha.jar].map(([k, v]) => `${k}=${v}`).join('; ') } })
  const cd = r.headers.get('content-disposition') ?? '', ct = r.headers.get('content-type') ?? ''
  check(r.status === 200, `status ${r.status}`)
  check(ct.startsWith('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'), `type ${ct}`)
  // android.webkit.URLUtil.parseContentDisposition
  const m = /attachment;\s*filename\s*=\s*("?)([^"]*)\1\s*$/i.exec(cd)
  check(m && m[2] === NAME, `Android would name it "${m?.[2] ?? '<id>.bin'}" (header: ${cd})`)
  check(Buffer.from(await r.arrayBuffer()).equals(xlsx), 'content differs')
  return `${ct} | ${cd}`
})

const profiles = {
  'chrome-desktop': { engine: chromium, exe: CHROME, ctx: { viewport: { width: 1366, height: 657 } } },
  'android-chrome': { engine: chromium, exe: CHROME, ctx: devices['Pixel 7'] },
  iphone: { engine: webkit, ctx: devices['iPhone 14'] },
}
for (const [key, p] of Object.entries(profiles)) {
  ok[key] = ok.upload && await tc(`DL-${key}`, `Download in ${key}`, 'tap download → file saved with the real name and content', async () => {
    const browser = await p.engine.launch({ headless: true, ...(p.exe ? { executablePath: p.exe } : {}) })
    try {
      const ctx = await browser.newContext({ ...p.ctx, baseURL: WEB, acceptDownloads: true, locale: 'en-IN', timezoneId: 'Asia/Kolkata' })
      const page = await ctx.newPage()
      page.setDefaultTimeout(20_000)
      await loginUI(page, EMP.email)
      await page.goto(`/chat?c=${conv}`)
      await page.getByTestId('chat-page').waitFor()
      const card = page.getByTestId('chat-file').filter({ hasText: NAME })
      await card.waitFor()
      await card.scrollIntoViewIfNeeded()
      const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 20_000 }), card.getByTestId('chat-file-download').click()])
      const saved = path.join(dir, `${key}-${tag}.xlsx`)
      await dl.saveAs(saved)
      check(dl.suggestedFilename() === NAME, `saved as "${dl.suggestedFilename()}"`)
      check(fs.readFileSync(saved).equals(xlsx), 'content differs')
      await view(page, `dl-${key}`)
      return `saved as "${dl.suggestedFilename()}"`
    } finally { await browser.close() }
  })
}

ok.iosShare = ok.upload && await tc('DL-ios-share', 'iPhone: when the share sheet is available, download opens it with the file', 'navigator.share called with one File named like the attachment', async () => {
  const browser = await webkit.launch({ headless: true })
  try {
    const ctx = await browser.newContext({ ...devices['iPhone 14'], baseURL: WEB })
    await ctx.addInitScript(() => {
      window.__shared = null
      navigator.canShare = (d) => !!d?.files?.length
      navigator.share = async (d) => { window.__shared = { name: d.files[0].name, size: d.files[0].size, type: d.files[0].type } }
    })
    const page = await ctx.newPage()
    page.setDefaultTimeout(20_000)
    await loginUI(page, EMP.email)
    await page.goto(`/chat?c=${conv}`)
    const card = page.getByTestId('chat-file').filter({ hasText: NAME })
    await card.waitFor()
    await card.getByTestId('chat-file-download').click()
    await until(() => page.evaluate(() => !!window.__shared), 'share sheet not opened', 10_000)
    const s = await page.evaluate(() => window.__shared)
    check(s.name === NAME && s.size === xlsx.length, `shared ${JSON.stringify(s)}`)
    return `shared ${s.name} (${s.size} B, ${s.type})`
  } finally { await browser.close() }
})

await closeAll()
writeResults('chat-downloads')
const all = Object.values(ok)
console.log(`${all.filter(Boolean).length}/${all.length} passed`)
process.exit(all.every(Boolean) ? 0 : 1)
await sleep(0)
