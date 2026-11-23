import { useState, type ReactNode } from 'react'
import { Plus } from 'lucide-react'
import type { Conversation } from '../../../api/chat'
import type { Section } from '../ChatPage'
import { NoteEditor, TaskEditor } from './Editors'
import { MyDay } from './MyDay'
import { NotesView } from './NotesView'
import { TasksView } from './TasksView'
import { NotifyPrompt } from '../NotifyPrompt'
import { IosSegmented } from '../IosSegmented'
import { useChat } from '../ChatProvider'
import '../chat.css'

const TITLE: Record<'myday' | 'notes' | 'tasks', string> = { myday: 'My Day', notes: 'Notes', tasks: 'Tasks' }
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
