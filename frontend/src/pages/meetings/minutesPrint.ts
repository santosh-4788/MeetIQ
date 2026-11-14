import { ACTION_STATUS_LABEL, PRIORITY_LABEL, type MinutesContent, type MinutesView } from '../../api/minutes'
import { formatCalendarDate, formatDate, formatDateTime, formatDuration, formatTime, parseUtc, zoneLabel } from '../../lib/format'
import { dbCategoryLabel, isCustomerCategory } from './meta'
import type { DbMeetingCategory } from '../../api/meetings'

// Print / "Save as PDF" layout for the minutes of meeting. The browser renders it, so every language (Hindi included) prints
// correctly - no PDF library or font file is needed. Nothing is uploaded or sent anywhere.

export const NOT_SPECIFIED = 'Not specified'

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
const text = (s: string | null | undefined) => (s && s.trim() ? `<p class="pre">${esc(s)}</p>` : `<p class="ns">${NOT_SPECIFIED}</p>`)

export function minutesDuration(startUtc: string | null, endUtc: string | null) {
  if (!startUtc || !endUtc) return null
  const mins = Math.round((parseUtc(endUtc).getTime() - parseUtc(startUtc).getTime()) / 60000)
  return mins >= 0 ? formatDuration(Math.max(1, mins)) : null
}

/** The whole printable document (also used by the end-to-end test to produce a PDF file as evidence). */
export function minutesPrintHtml(view: MinutesView, content: MinutesContent, tz: string, label: { status: string; detail: string }) {
  const m = view.meeting
  const customer = isCustomerCategory(m.category)
  const rows: [string, string][] = [
    ['Meeting ID', m.meetingCode],
    ['Title', m.title],
    ['Category', dbCategoryLabel[m.category as DbMeetingCategory] ?? m.category],
    ['Date', formatDate(m.actualStartUtc ?? m.startUtc, tz)],
    ['Scheduled', `${formatTime(m.startUtc, tz)} – ${formatTime(m.endUtc, tz)} ${zoneLabel(tz)}`],
    ['Actual', m.actualStartUtc ? `${formatTime(m.actualStartUtc, tz)} – ${m.actualEndUtc ? formatTime(m.actualEndUtc, tz) : 'not ended'} ${zoneLabel(tz)}` : NOT_SPECIFIED],
    ['Actual duration', minutesDuration(m.actualStartUtc, m.actualEndUtc) ?? NOT_SPECIFIED],
    ['Host', m.host],
    ['Organiser', m.organiser],
  ]
  if (customer) {
    rows.push(['Customer', m.customerName ?? NOT_SPECIFIED])
    rows.push(['Prarambh Main ID', m.prarambhMainId ?? NOT_SPECIFIED])
  }
  const people = m.participants
    .map((p) => `<li>${esc(p.name)}${p.role !== 'ATTENDEE' ? ` <span class="muted">(${p.role === 'HOST' ? 'host' : 'co-host'})</span>` : ''} – ${p.attended ? 'attended' : '<span class="muted">did not join</span>'}</li>`)
    .join('')
  const items = content.actionItems.length
    ? `<table class="items"><thead><tr><th>#</th><th>Action</th><th>Assigned to</th><th>Due</th><th>Priority</th><th>Status</th></tr></thead><tbody>${content.actionItems
        .map((a, i) => `<tr><td>${i + 1}</td><td class="pre">${esc(a.description)}</td><td>${a.assignee ? esc(a.assignee.name) : NOT_SPECIFIED}</td><td>${a.dueDate ? formatCalendarDate(a.dueDate) : NOT_SPECIFIED}</td><td>${PRIORITY_LABEL[a.priority]}</td><td>${ACTION_STATUS_LABEL[a.status]}</td></tr>`)
        .join('')}</tbody></table>`
    : `<p class="ns">No action items.</p>`

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(`Minutes - ${m.meetingCode} - ${m.title}`)}</title><style>
    @page { size: A4; margin: 16mm 14mm; }
    * { box-sizing: border-box; }
    body { font-family: "Segoe UI", "Nirmala UI", "Noto Sans", "Noto Sans Devanagari", Arial, sans-serif; color: #102A43; font-size: 11pt; line-height: 1.45; margin: 0; }
    h1 { font-size: 17pt; margin: 0 0 2pt; } h2 { font-size: 12pt; margin: 14pt 0 4pt; border-bottom: 1px solid #D9E2EC; padding-bottom: 2pt; }
    .status { display: inline-block; font-weight: 600; padding: 2pt 6pt; border-radius: 4pt; font-size: 9.5pt; }
    .draft { background: #FFF4D6; color: #7A4F01; } .approved { background: #DCFCE7; color: #166534; }
    .muted, .ns { color: #627D98; } .ns { font-style: italic; margin: 0; } .pre { white-space: pre-wrap; margin: 0; overflow-wrap: anywhere; }
    table { border-collapse: collapse; width: 100%; } td, th { text-align: left; vertical-align: top; padding: 3pt 5pt; border: 1px solid #D9E2EC; font-size: 10pt; }
    table.facts td:first-child { width: 32%; color: #486581; } th { background: #F0F4F8; }
    tr { page-break-inside: avoid; } ul { margin: 0; padding-left: 16pt; }
    footer { margin-top: 18pt; font-size: 8.5pt; color: #627D98; }
  </style></head><body>
    <h1>Minutes of meeting</h1>
    <p style="margin:0 0 8pt"><span class="status ${label.status === 'Approved' ? 'approved' : 'draft'}">${esc(label.status)}</span> <span class="muted">${esc(label.detail)}</span></p>
    <h2>Meeting details</h2>
    <table class="facts"><tbody>${rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</tbody></table>
    <h2>Participants</h2><ul>${people}</ul>
    <h2>Discussion summary</h2>${text(content.discussionSummary)}
    ${customer || content.customerRequirements ? `<h2>Customer requirements</h2>${text(content.customerRequirements)}` : ''}
    <h2>Decisions</h2>${text(content.decisions)}
    <h2>Pending activities</h2>${text(content.pendingActivities)}
    <h2>Follow-up date</h2><p class="pre">${content.followUpDate ? formatCalendarDate(content.followUpDate) : `<span class="ns">${NOT_SPECIFIED}</span>`}</p>
    <h2>Action items</h2>${items}
    <footer>Written by people from the meeting; not generated by AI. Printed ${esc(formatDateTime(new Date().toISOString(), tz))} ${zoneLabel(tz)} from OneInsure Connect.</footer>
  </body></html>`
}

/** Opens the browser's print dialog (choose "Save as PDF") for the given document, from a hidden frame - no pop-up window. */
export function printHtml(html: string) {
  const frame = document.createElement('iframe')
  frame.setAttribute('aria-hidden', 'true')
  frame.setAttribute('data-testid', 'minutes-print-frame')
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden'
  document.body.appendChild(frame)
  const doc = frame.contentDocument!
  doc.open()
  doc.write(html)
  doc.close()
  const done = () => setTimeout(() => frame.remove(), 1000)
  frame.contentWindow!.addEventListener('afterprint', done)
  setTimeout(() => {
    frame.contentWindow!.focus()
    frame.contentWindow!.print()
    // Some browsers do not fire afterprint for an iframe; remove it after a minute anyway.
    setTimeout(done, 60_000)
  }, 150)
}
