// Chat on phones (21 Nov 2026 fix, from an iPhone Chrome screenshot): an open conversation fills the screen (no portal
// header / tab bar over it), the message box stays visible when the keyboard opens (smaller visual viewport), and a
// long file name never makes a bubble wider than the screen. iPhone (WebKit), iPhone SE, Android Chrome.
// Isolated environment only. Run:  cd "E:\Beeinsured.com\MeetIQ\tests\e2e"; node room\chat-phone-view.mjs
import path from 'node:path'
import zlib from 'node:zlib'
import { chromium, devices, webkit } from 'playwright-core'
setTimeout(() => { console.log('WATCHDOG'); process.exit(2) }, 8 * 60_000).unref()
import { Api, EMP, HOST, SHOTS, WEB, check, closeAll, exec, loginUI, scalar, sleep, tc, until, writeResults } from './harness.mjs'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const tag = Date.now().toString(36).slice(-5)
const NAME = `4. Undertaking - not holding ins license Rama ${tag}.docx`
exec("UPDATE app.FeatureSettings SET IsEnabled = 1 WHERE FeatureKey IN ('CHAT','CHAT_CALLS','CHAT_TASKS','CHAT_ADVANCED')")
const ok = {}

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
const docx = zip({
  '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  '_rels/.rels': '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  'word/document.xml': '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Undertaking</w:t></w:r></w:p></w:body></w:document>',
})

const hema = await new Api().login(HOST.email)
let conv
ok.setup = await tc('PV-01', 'Hema sends Esha a Word file with a long name', 'upload → CLEAN', async () => {
  const people = await hema.req('GET', `/chat/people?search=Esha`)
  const person = (people.data?.items ?? people.data ?? []).find((p) => /Esha/.test(p.name))
  conv = (await hema.req('POST', '/chat/direct', { userId: person.id })).data.id
  const form = new FormData()
  form.append('file', new Blob([docx]), NAME)
  form.append('clientMessageId', crypto.randomUUID())
  const headers = { Cookie: [...hema.jar].map(([k, v]) => `${k}=${v}`).join('; '), 'X-XSRF-TOKEN': decodeURIComponent(hema.jar.get('XSRF-TOKEN')) }
  const up = await fetch(`${WEB}/api/v1/chat/conversations/${conv}/files`, { method: 'POST', headers, body: form })
  check(up.ok, `upload ${up.status} ${await up.text()}`)
  await until(() => scalar(`SELECT TOP 1 ScanStatus AS v FROM chat.TRN_ChatFile WHERE OriginalName = N'${NAME}'`) === 'CLEAN', 'not scanned clean', 60_000)
  return 'sent'
})

const profiles = {
  iphone: { engine: webkit, ctx: devices['iPhone 14'] },
  'iphone-se': { engine: webkit, ctx: devices['iPhone SE'] },
  'android-chrome': { engine: chromium, exe: CHROME, ctx: devices['Pixel 7'] },
}
for (const [key, p] of Object.entries(profiles)) {
  ok[key] = ok.setup && await tc(`PV-${key}`, `${key}: full-screen conversation, message box above the keyboard, long file name fits`, 'no header/tab bar over the chat; composer visible at full and keyboard height; bubble inside the screen', async () => {
    const browser = await p.engine.launch({ headless: true, ...(p.exe ? { executablePath: p.exe } : {}) })
    try {
      const ctx = await browser.newContext({ ...p.ctx, baseURL: WEB, locale: 'en-IN', timezoneId: 'Asia/Kolkata' })
      const page = await ctx.newPage()
      page.setDefaultTimeout(20_000)
      await loginUI(page, EMP.email)
      await page.goto(`/chat?c=${conv}`)
      const card = page.getByTestId('chat-file').filter({ hasText: NAME })
      await card.waitFor()
      await sleep(600)
      const vw = p.ctx.viewport.width, vh = p.ctx.viewport.height
      const layout = await page.evaluate(() => {
        const chat = document.querySelector('[data-testid="chat-page"]')
        const r = chat.getBoundingClientRect()
        const at = (x, y) => !!document.elementFromPoint(x, y)?.closest('[data-testid="chat-page"]')
        const tab = document.querySelector('[data-testid="mobile-tabbar"]')
        return { top: r.top, bottom: r.bottom, h: r.height, topIsChat: at(innerWidth / 2, 30), bottomIsChat: at(innerWidth / 2, innerHeight - 30), tabVisible: !!tab && at(innerWidth / 2, innerHeight - 30) === false, docOverflow: document.documentElement.scrollWidth - innerWidth }
      })
      check(layout.topIsChat, 'portal header is over the top of the chat')
      check(layout.bottomIsChat, 'tab bar is over the bottom of the chat')
      check(Math.abs(layout.h - vh) <= 2, `chat height ${layout.h} vs screen ${vh}`)
      const box = await card.boundingBox()
      check(box.x >= 0 && box.x + box.width <= vw + 0.5, `file bubble outside the screen (${Math.round(box.x)}..${Math.round(box.x + box.width)} of ${vw})`)
      const composer = page.getByTestId('chat-input')
      const c1 = await composer.boundingBox()
      check(c1 && c1.y + c1.height <= vh, 'message box below the screen')
      await page.screenshot({ path: path.join(SHOTS, `view-pv-${key}.png`) })

      // Keyboard open: the visible area shrinks (Android resizes the window; iOS shrinks the visual viewport).
      const kb = Math.round(vh * 0.55)
      await composer.click()
      await page.setViewportSize({ width: vw, height: kb })
      await sleep(500)
      const c2 = await composer.boundingBox()
      check(c2 && c2.y >= 0 && c2.y + c2.height <= kb, `message box hidden with the keyboard open (${c2 && Math.round(c2.y + c2.height)} > ${kb})`)
      const last = await card.boundingBox()
      check(last && last.y + last.height > 0 && last.y < kb, `newest message not visible with the keyboard open (${last && Math.round(last.y)})`)
      const head = await page.getByTestId('chat-back').boundingBox()
      check(head && head.y >= 0, 'chat header pushed off the screen')
      await page.screenshot({ path: path.join(SHOTS, `view-pv-${key}-keyboard.png`) })
      await page.setViewportSize({ width: vw, height: vh })

      // Back to the list: header and tab bar return, nothing left locked.
      await page.getByTestId('chat-back').click()
      await page.getByTestId('chat-list').waitFor()
      await page.getByTestId('mobile-tabbar').waitFor()
      const locked = await page.evaluate(() => document.documentElement.classList.contains('oic-chat-locked'))
      check(!locked, 'page still locked after going back')
      return `full screen ${Math.round(layout.h)} px; bubble ${Math.round(box.x)}..${Math.round(box.x + box.width)} / ${vw}; composer visible with keyboard`
    } finally { await browser.close() }
  })
}

await closeAll()
writeResults('chat-phone-view')
const all = Object.values(ok)
console.log(`${all.filter(Boolean).length}/${all.length} passed`)
process.exit(all.every(Boolean) ? 0 : 1)
await sleep(0)
