import { http } from './http'
import type { Call } from './calls'

// Chat Phase 4 (V030, documentation/CHAT_MODULE_PHASE4.md): personal notes, tasks, reminders and My Day.
// Everything here is private to the signed-in employee; the server answers 404 for anything that is not theirs.

export type Priority = 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT'
export type TaskStatus = 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'POSTPONED' | 'CANCELLED'
export type RepeatRule = 'NONE' | 'DAILY' | 'WEEKDAYS' | 'WEEKLY' | 'MONTHLY'
export type ReminderState = 'PENDING' | 'FIRED' | 'DONE' | 'CANCELLED' | 'DISMISSED'

export type Category = { id: string; name: string; color: string; isDefault: boolean }
export type LinkMeeting = { id: string; title: string; startUtc: string }
export type LinkEmployee = { id: string; name: string; code: string | null }
export type LinkConversation = { id: string; title: string; isGroup: boolean }
export type LinkTask = { id: string; title: string; status: TaskStatus }
export type LinkNote = { id: string; title: string }
export type LinkMessage = { id: string; conversationId: string; senderName: string | null; excerpt: string; sentUtc: string }
export type LinkCall = { id: string; type: string; startedUtc: string; otherName: string | null }

export type Note = {
  id: string
  title: string
  body: string | null
  categoryId: string | null
  categoryName: string | null
  categoryColor: string | null
  isPinned: boolean
  isCompleted: boolean
  isArchived: boolean
  noteDateUtc: string | null
  reminderId: string | null
  reminderUtc: string | null
  reminderState: ReminderState | null
  meeting: LinkMeeting | null
  task: LinkTask | null
  employee: LinkEmployee | null
  conversation: LinkConversation | null
  createdUtc: string
  updatedUtc: string
}

export type Task = {
  id: string
  title: string
  description: string | null
  notes: string | null
  priority: Priority
  status: TaskStatus
  dueUtc: string | null
  hasDueTime: boolean
  isOverdue: boolean
  categoryId: string | null
  categoryName: string | null
  categoryColor: string | null
  repeatRule: RepeatRule
  reminderId: string | null
  reminderUtc: string | null
  reminderState: ReminderState | null
  completedUtc: string | null
  meeting: LinkMeeting | null
  employee: LinkEmployee | null
  conversation: LinkConversation | null
  message: LinkMessage | null
  call: LinkCall | null
  note: LinkNote | null
  createdUtc: string
  updatedUtc: string
}

export type Reminder = {
  id: string
  kind: 'TASK' | 'NOTE'
  itemId: string
  title: string
  details: string | null
  priority: Priority | null
  dueUtc: string
  firedUtc: string | null
  state: ReminderState
  snoozeCount: number
  taskDueUtc: string | null
}

export type MyDayMeeting = { id: string; title: string; startUtc: string; endUtc: string | null; status: string; kind?: string | null; joinPath?: string | null }
export type ImportantChat = { id: string; title: string; isGroup: boolean; unread: number; lastMessageExcerpt: string | null; lastMessageUtc: string | null; isPinned: boolean }

export type MyDay = {
  todayTasks: Task[]
  overdueTasks: Task[]
  upcomingReminders: Reminder[]
  missedReminders: Reminder[]
  meetings: MyDayMeeting[]
  notes: Note[]
  followUps: Task[]
  importantChats: ImportantChat[]
  recentCalls: Call[]
  counts: { todayTasks: number; overdue: number; missed: number; followUps: number }
}

export type NoteFilter = 'all' | 'today' | 'pinned' | 'completed' | 'archived' | 'reminders'
export type TaskFilter = 'all' | 'today' | 'week' | 'overdue' | 'upcoming' | 'completed' | 'followups'

export type NoteInput = Partial<{
  title: string
  body: string | null
  categoryId: string | null
  isPinned: boolean
  isCompleted: boolean
  isArchived: boolean
  noteDateUtc: string | null
  reminderUtc: string | null
  meetingId: string | null
  taskId: string | null
  employeeId: string | null
  conversationId: string | null
}>

export type TaskInput = Partial<{
  title: string
  description: string | null
  notes: string | null
  priority: Priority
  status: TaskStatus
  dueUtc: string | null
  hasDueTime: boolean
  categoryId: string | null
  repeatRule: RepeatRule
  reminderUtc: string | null
  meetingId: string | null
  employeeId: string | null
  conversationId: string | null
  sourceMessageId: string | null
  sourceCallId: string | null
  noteId: string | null
}>

const q = (params: Record<string, string | number | null | undefined>) => {
  const s = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') s.set(k, String(v))
  const t = s.toString()
  return t ? `?${t}` : ''
}

/** Today in the browser's time zone as a UTC window (the server filters "today" with it). */
export function dayWindow(d = new Date()) {
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  const end = new Date(start.getTime())
  end.setDate(end.getDate() + 1)
  return { dayStartUtc: start.toISOString(), dayEndUtc: end.toISOString() }
}

export const workApi = {
  categories: () => http<Category[]>('/chat/categories'),
  addCategory: (name: string, color: string) => http<Category>('/chat/categories', { method: 'POST', body: { name, color } }),
  removeCategory: (id: string) => http<void>(`/chat/categories/${id}`, { method: 'DELETE' }),

  notes: (p: { filter?: NoteFilter; search?: string; from?: string; to?: string } = {}) => http<{ items: Note[] }>(`/chat/notes${q({ ...p, ...dayWindow() })}`),
  note: (id: string) => http<Note>(`/chat/notes/${id}`),
  createNote: (b: NoteInput) => http<Note>('/chat/notes', { method: 'POST', body: b }),
  updateNote: (id: string, b: NoteInput) => http<Note>(`/chat/notes/${id}`, { method: 'PATCH', body: b }),
  deleteNote: (id: string) => http<void>(`/chat/notes/${id}`, { method: 'DELETE' }),

  tasks: (p: { filter?: TaskFilter; search?: string; status?: TaskStatus } = {}) => http<{ items: Task[] }>(`/chat/tasks${q({ ...p, ...dayWindow() })}`),
  task: (id: string) => http<Task>(`/chat/tasks/${id}`),
  createTask: (b: TaskInput) => http<Task>('/chat/tasks', { method: 'POST', body: b }),
  updateTask: (id: string, b: TaskInput) => http<Task>(`/chat/tasks/${id}`, { method: 'PATCH', body: b }),
  setStatus: (id: string, status: TaskStatus) => http<{ task: Task; next: Task | null }>(`/chat/tasks/${id}/status`, { method: 'POST', body: { status } }),
  deleteTask: (id: string) => http<void>(`/chat/tasks/${id}`, { method: 'DELETE' }),

  dueReminders: () => http<Reminder[]>('/chat/reminders/due'),
  upcomingReminders: (days = 7) => http<Reminder[]>(`/chat/reminders/upcoming${q({ days })}`),
  snooze: (id: string, b: { minutes?: number; untilUtc?: string }) => http<Reminder>(`/chat/reminders/${id}/snooze`, { method: 'POST', body: b }),
  done: (id: string) => http<void>(`/chat/reminders/${id}/done`, { method: 'POST', body: {} }),
  dismiss: (id: string) => http<void>(`/chat/reminders/${id}/dismiss`, { method: 'POST', body: {} }),

  /** Phase 5 quick follow-up panel (CHAT_ADVANCED). */
  followupPanel: () => http<{ overdue: Task[]; today: Task[]; week: Task[] }>('/chat/tasks/followup-panel'),
  myDay: () => http<MyDay>(`/chat/my-day${q(dayWindow())}`),
  meetings: (search: string) => http<LinkMeeting[]>(`/chat/work/meetings${q({ search })}`),
}
