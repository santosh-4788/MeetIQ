import { useEffect, useMemo, useRef, useState } from 'react'
import { Search } from 'lucide-react'
import { cn } from '../../lib/cn'

// Native Unicode emoji from our own list (no package, no image service). Recently used ones are remembered on this device.

const GROUPS: { key: string; label: string; icon: string; emoji: string }[] = [
  { key: 'smileys', label: 'Smileys', icon: '😀', emoji: '😀 😃 😄 😁 😆 😅 😂 🤣 🙂 🙃 😉 😊 😇 🥰 😍 🤩 😘 😗 😚 😋 😛 😜 🤪 😝 🤑 🤗 🤭 🤫 🤔 🤐 🤨 😐 😑 😶 😏 😒 🙄 😬 😌 😔 😪 😴 😷 🤒 🤕 🤧 🥵 🥶 😵 🤯 🤠 🥳 😎 🤓 🧐 😕 😟 🙁 😮 😯 😲 😳 🥺 😦 😧 😨 😰 😥 😢 😭 😱 😖 😣 😞 😓 😩 😫 🥱 😤 😡 😠 🤬' },
  { key: 'gestures', label: 'Gestures & people', icon: '👍', emoji: '👍 👎 👌 🤌 ✌️ 🤞 🤟 🤘 🤙 👈 👉 👆 👇 ☝️ ✋ 🤚 🖐️ 🖖 👋 🤝 🙏 👏 🙌 👐 🤲 💪 ✍️ 💅 👀 👁️ 🧠 🙋 🙆 🙅 🤷 🤦 🙇 💁 👨‍💻 👩‍💻 🧑‍💼 👨‍💼 👩‍💼 🧑‍🤝‍🧑 👪' },
  { key: 'hearts', label: 'Hearts & symbols', icon: '❤️', emoji: '❤️ 🧡 💛 💚 💙 💜 🤎 🖤 🤍 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝 ✅ ☑️ ✔️ ❌ ❎ ⭕ ❗ ❓ ‼️ ⁉️ 💯 🔥 ✨ ⭐ 🌟 💫 ⚡ 💥 🎯 🔔 🔕 📌 📍 🚩 ⚠️ 🚫 ⛔ 🆗 🆕 🔝 ➕ ➖ ✖️ ➡️ ⬅️ ⬆️ ⬇️ 🔄' },
  { key: 'celebration', label: 'Celebration', icon: '🎉', emoji: '🎉 🎊 🥳 🎂 🍰 🧁 🎁 🎈 🏆 🥇 🥈 🥉 🏅 🎖️ 🎗️ 🪔 🎆 🎇 🌸 💐 🌹 🌻 🌼 🌷' },
  { key: 'work', label: 'Work', icon: '💼', emoji: '💼 📁 📂 🗂️ 📄 📃 📑 📊 📈 📉 🗒️ 🗓️ 📅 📆 ⏰ ⏳ ⌛ ⏱️ 📝 ✏️ 🖊️ 📎 🖇️ 📏 ✂️ 🗃️ 🗄️ 🗑️ 🔒 🔓 🔑 💻 🖥️ 🖨️ ⌨️ 🖱️ 📱 ☎️ 📞 📧 📨 📩 📤 📥 📦 🏢 🏦 💰 💳 🧾 💡 🔍 🛡️ ⚙️ 🔧 🧮' },
  { key: 'food', label: 'Food & travel', icon: '☕', emoji: '☕ 🍵 🥤 🧃 🍕 🍔 🍟 🌭 🥪 🍛 🍚 🍜 🍝 🥗 🍿 🍩 🍪 🍫 🍎 🍌 🍇 🍉 🥭 🚗 🚕 🚌 🚆 ✈️ 🚀 🏠 🏖️ ⛰️ 🌍 ☀️ 🌤️ ⛅ 🌧️ ⛈️ ❄️ 🌈' },
]

const RECENT_KEY = 'oic.chat.recentEmoji'
export const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '🙏', '✅']

function split(s: string) {
  return s.split(' ').filter(Boolean)
}

export function readRecent(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]')
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, 24) : []
  } catch {
    return []
  }
}

export function rememberEmoji(e: string) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([e, ...readRecent().filter((x) => x !== e)].slice(0, 24)))
  } catch {
    /* storage unavailable: recents simply aren't remembered */
  }
}

// Search by group name and a few common words (English); emoji themselves are matched exactly.
const WORDS: Record<string, string> = {
  '👍': 'thumbs up yes ok like agree', '👎': 'thumbs down no dislike', '❤️': 'heart love red', '😂': 'laugh joy lol tears', '🙏': 'thanks please pray namaste',
  '✅': 'done check tick yes complete', '❌': 'no cross wrong cancel', '🎉': 'party celebrate congrats tada', '🔥': 'fire hot lit', '👏': 'clap applause well done',
  '😊': 'smile happy blush', '😀': 'grin smile happy', '😢': 'cry sad tear', '😮': 'wow surprised', '🤔': 'think hmm', '👀': 'eyes look see', '💯': 'hundred perfect',
  '☕': 'coffee tea break', '📎': 'attach clip', '📅': 'calendar date', '⏰': 'alarm time reminder', '📞': 'phone call', '💼': 'work office bag', '🤝': 'handshake deal agree',
  '👋': 'wave hello hi bye', '🙌': 'hooray raise hands', '💪': 'strong muscle', '😎': 'cool sunglasses', '🥳': 'party birthday', '🎂': 'birthday cake', '🪔': 'diya diwali lamp',
  '⚠️': 'warning caution', '📌': 'pin important', '💡': 'idea bulb', '🚀': 'launch rocket fast', '😅': 'sweat relief', '🤣': 'rofl laugh', '😍': 'love eyes', '🤞': 'fingers crossed luck',
}

export function EmojiPicker({ onPick, onClose, className }: { onPick: (emoji: string) => void; onClose: () => void; className?: string }) {
  const [group, setGroup] = useState(() => (readRecent().length ? 'recent' : 'smileys'))
  const [query, setQuery] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  const recent = useMemo(readRecent, [])

  useEffect(() => {
    const onDown = (e: MouseEvent | TouchEvent) => ref.current && !ref.current.contains(e.target as Node) && onClose()
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && (e.stopPropagation(), onClose())
    document.addEventListener('mousedown', onDown)
    document.addEventListener('touchstart', onDown)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('touchstart', onDown)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [onClose])

  const list = useMemo(() => {
    const t = query.trim().toLowerCase()
    if (t) {
      const all = GROUPS.flatMap((g) => split(g.emoji).map((e) => ({ e, g: g.label.toLowerCase() })))
      return all.filter(({ e, g }) => e === t || g.includes(t) || (WORDS[e] ?? '').includes(t)).map((x) => x.e)
    }
    if (group === 'recent') return recent
    return split(GROUPS.find((g) => g.key === group)?.emoji ?? '')
  }, [group, query, recent])

  const pick = (e: string) => {
    rememberEmoji(e)
    onPick(e)
  }

  return (
    <div ref={ref} role="dialog" aria-label="Emoji" className={cn('z-50 w-[300px] max-w-[calc(100vw-24px)] rounded-lg border border-line bg-surface p-2 shadow-overlay', className)} data-testid="emoji-picker">
      <label className="mb-2 flex h-8 items-center gap-2 rounded-sm border border-line px-2 text-ink-muted focus-within:border-brand-500">
        <Search className="size-3.5" aria-hidden />
        <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search emoji" className="min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none" aria-label="Search emoji" />
      </label>
      {!query && (
        <div className="mb-1.5 flex gap-0.5 border-b border-line pb-1.5" role="tablist">
          {[...(recent.length ? [{ key: 'recent', label: 'Recently used', icon: '🕘' }] : []), ...GROUPS].map((g) => (
            <button
              key={g.key}
              type="button"
              role="tab"
              aria-selected={group === g.key}
              title={g.label}
              aria-label={g.label}
              onClick={() => setGroup(g.key)}
              className={cn('flex size-8 items-center justify-center rounded-sm text-[17px]', group === g.key ? 'bg-brand-50' : 'hover:bg-surface-muted')}
            >
              {g.icon}
            </button>
          ))}
        </div>
      )}
      <div className="grid max-h-[220px] grid-cols-8 gap-0.5 overflow-y-auto scrollbar-thin">
        {list.map((e) => (
          <button key={e} type="button" onClick={() => pick(e)} className="flex size-[34px] items-center justify-center rounded-sm text-[20px] hover:bg-surface-muted focus-visible:bg-brand-50" aria-label={e}>
            {e}
          </button>
        ))}
        {list.length === 0 && <p className="col-span-8 py-6 text-center text-[12.5px] text-ink-muted">No emoji found</p>}
      </div>
    </div>
  )
}
