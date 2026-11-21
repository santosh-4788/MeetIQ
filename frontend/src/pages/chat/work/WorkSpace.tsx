import { useState, type ReactNode } from 'react'
import { BellRing, Plus, X } from 'lucide-react'
import type { Conversation } from '../../../api/chat'
import type { Section } from '../ChatPage'
import { NoteEditor, TaskEditor } from './Editors'
import { MyDay } from './MyDay'
import { NotesView } from './NotesView'
import { TasksView, useBrowserNotifications } from './TasksView'
import { IosSegmented } from '../IosSegmented'
import { useChat } from '../ChatProvider'
import '../chat.css'

const TITLE: Record<'myday' | 'notes' | 'tasks', string> = { myday: 'My Day', notes: 'Notes', tasks: 'Tasks' }
const PROMPT_KEY = 'oic.tasks.notify-prompt'

function readDismissed() {
  try {
    return localStorage.getItem(PROMPT_KEY) === 'no'
  } catch {
    return false
  }
}

/** One-time, dismissible prompt to allow browser notifications (asked only when tapped, never on load). */
function NotifyPrompt() {
  const { perm, ask } = useBrowserNotifications()
  const [hidden, setHidden] = useState(readDismissed)
  if (perm !== 'default' || hidden) return null
  const dismiss = () => {
    setHidden(true)
    try {
      localStorage.setItem(PROMPT_KEY, 'no')
    } catch {
      /* private mode */
    }
  }
  return (
    <div className="mx-auto mb-3 flex max-w-[1100px] items-center gap-3 rounded-[14px] bg-white px-3.5 py-2.5 shadow-xs" data-testid="notify-prompt">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-[9px] bg-[var(--ios-red)] text-white"><BellRing className="size-4" /></span>
      <p className="min-w-0 flex-1 text-[14px] leading-[18px]"><b>Never miss a task.</b> <span className="text-[var(--ios-label2)]">Get a notification when someone assigns you a task or sends one for review.</span></p>
      <button type="button" onClick={() => void ask()} className="ios-btn-filled h-[32px] shrink-0 px-3 text-[14px]" data-testid="notify-prompt-on">Turn on</button>
      <button type="button" onClick={dismiss} aria-label="Not now" className="text-[var(--ios-gray2)]"><X className="size-4" /></button>
    </div>
  )
}

/** The productivity half of the Chat workspace (Phase 4): My Day, Notes and Tasks, in the iOS look. */
export default function WorkSpace({
  section, tabs, params, setParams, onOpenChat, onSection, onNewChat, onNewGroup,
}: {
  section: 'myday' | 'notes' | 'tasks'
  tabs: ReactNode
  params: URLSearchParams
  setParams: (p: URLSearchParams) => void
  conversations: Conversation[]
  onOpenChat: (id: string) => void
  onOpenDirect: (userId: string) => void
  onSection: (s: Section) => void
  onNewChat: () => void
  onNewGroup: () => void
}) {
  const [adding, setAdding] = useState<'task' | 'note' | null>(null)
  const [refresh, setRefresh] = useState(0)
  const chat = useChat()
  const collab = !!(chat.status?.enabled && chat.status.taskCollab)
  return (
    <div className="flex h-full w-full flex-col">
      <header className="shrink-0 px-4 pt-2.5 sm:px-6">
        <div className={section === 'myday' ? 'h-1' : 'mx-auto flex h-9 max-w-[1100px] items-center justify-end'}>
          {section !== 'myday' && (
            <button type="button" onClick={() => setAdding(section === 'tasks' ? 'task' : 'note')} aria-label={section === 'tasks' ? 'New task' : 'New note'} className="ios-icon-btn" data-testid="work-add">
              <Plus className="size-[24px]" strokeWidth={2.2} />
            </button>
          )}
        </div>
        <div className="mx-auto max-w-[1100px]">
          <h1 className="ios-large-title">{TITLE[section]}</h1>
          {tabs && <div className="mt-2.5 max-w-[620px]">{tabs}</div>}
          <div className="mt-2.5 max-w-[420px]">
            <IosSegmented label="My Day, Tasks and Notes" value={section} onChange={(s) => onSection(s)} testIdPrefix="work-section-"
              options={[{ key: 'myday', label: 'My Day' }, { key: 'tasks', label: 'Tasks' }, { key: 'notes', label: 'Notes' }]} />
          </div>
        </div>
      </header>
      <div className="ios-fade flex-1 overflow-y-auto px-4 pt-4 pb-8 scrollbar-thin sm:px-6" key={section + refresh}>
        {collab && section !== 'notes' && <NotifyPrompt />}
        {section === 'myday' && <MyDay onSection={onSection} onOpenChat={onOpenChat} onNewChat={onNewChat} onNewGroup={onNewGroup} />}
        {section === 'tasks' && <TasksView params={params} setParams={setParams} />}
        {section === 'notes' && <NotesView params={params} setParams={setParams} />}
      </div>
      {adding === 'task' && <TaskEditor onClose={() => setAdding(null)} onSaved={() => setRefresh((n) => n + 1)} />}
      {adding === 'note' && <NoteEditor onClose={() => setAdding(null)} onSaved={() => setRefresh((n) => n + 1)} />}
    </div>
  )
}
