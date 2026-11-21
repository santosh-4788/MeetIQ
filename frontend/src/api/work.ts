import { API_BASE } from '../config'
import { http } from './http'
import { uploadFile } from './chat'
import type { Call } from './calls'

// Chat Phase 4 (V030, documentation/CHAT_MODULE_PHASE4.md): personal notes, tasks, reminders and My Day.
// Everything here is private to the signed-in employee; the server answers 404 for anything that is not theirs.
// Task collaboration (V033, switch TASK_COLLAB): a task can be assigned to colleagues (one copy each, visible to the owner and
// the person who assigned it), reviewed before it is closed, discussed in comments, and notes can be shared read-only.

export type Priority = 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT'
export type TaskStatus = 'PENDING' | 'IN_PROGRESS' | 'IN_REVIEW' | 'COMPLETED' | 'POSTPONED' | 'CANCELLED'
export type TaskRole = 'mine' | 'assignee' | 'assigner'
export type AssignState = 'PENDING' | 'ACCEPTED' | 'DECLINED'
export type PersonRef = { id: string; name: string | null }
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
  /** V033: optional colour, how many colleagues it is shared with; shared notes (from others) are read-only. */
  color?: string | null
  sharedCount?: number
  isShared?: boolean
  ownerName?: string | null
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
  // V033 collaboration
  role: TaskRole
  owner: PersonRef
  assignedBy: PersonRef | null
  assignmentKey: string | null
  assignState: AssignState | null
  requiresReview: boolean
  requestedDueUtc: string | null
  requestReason: string | null
  submittedUtc: string | null
  reviewedUtc: string | null
  focusUtc: string | null
  checklist: { total: number; done: number; requiredOpen: number }
  commentCount: number
  fileCount: number
  canComplete: boolean
  canSubmit: boolean
  canReview: boolean
  canEditDetails: boolean
}

export type ChecklistItem = { id: string; text: string; isRequired: boolean; isDone: boolean; doneUtc: string | null; createdBy: PersonRef; canEdit: boolean; canTick: boolean }
export type ActivityKind = 'CREATED' | 'ASSIGNED' | 'ACCEPTED' | 'DECLINED' | 'DATE_REQUESTED' | 'DATE_APPROVED' | 'DATE_REJECTED' | 'EDITED' | 'STARTED'
  | 'SUBMITTED' | 'APPROVED' | 'RETURNED' | 'COMPLETED' | 'REOPENED' | 'CANCELLED' | 'COMMENT' | 'FILE' | 'OVERDUE' | 'NUDGED'
export type Activity = { id: string; kind: ActivityKind; body: string | null; dueUtc: string | null; createdUtc: string; actor: (PersonRef & { isMe: boolean }) | null }
export type TaskFile = { id: string; name: string; extension: string; sizeBytes: number; scanStatus: 'PENDING' | 'CLEAN' | 'BLOCKED' | 'ERROR'; createdUtc: string; inlinePreview: boolean; uploadedBy: PersonRef; canDelete: boolean }
export type TaskDetails = { checklist: ChecklistItem[]; activity: Activity[]; files: TaskFile[]; canAddRequired: boolean; collab: boolean }
export type Assignee = { id: string; name: string; code: string | null; department: string | null; designation: string | null }
export type NoteShare = { id: string; name: string | null; sharedUtc: string }

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
  counts: { todayTasks: number; overdue: number; missed: number; followUps: number; completedToday?: number; toReview?: number; waitingOnOthers?: number }
  // V033
  focus?: Task[]
  newAssigned?: Task[]
  toReview?: Task[]
  waitingOnOthers?: Task[]
}

export type NoteFilter = 'all' | 'today' | 'pinned' | 'completed' | 'archived' | 'reminders' | 'shared'
export type TaskFilter = 'all' | 'today' | 'week' | 'overdue' | 'upcoming' | 'completed' | 'followups' | 'assigned' | 'delegated' | 'to-review' | 'focus'

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
  color: string | null
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
  /** V033: give the task to these colleagues (one copy each). */
  assigneeIds: string[]
  requiresReview: boolean
  checklist: { text: string; isRequired: boolean }[]
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

  // ---- V033 collaboration
  assignees: (search: string) => http<{ items: Assignee[] }>(`/chat/tasks/assignees${q({ search })}`),
  settings: () => http<{ taskEmails: boolean; collab: boolean }>('/chat/tasks/settings'),
  saveSettings: (taskEmails: boolean) => http<{ taskEmails: boolean; collab: boolean }>('/chat/tasks/settings', { method: 'PUT', body: { taskEmails } }),
  details: (id: string) => http<TaskDetails>(`/chat/tasks/${id}/details`),
  focus: (id: string, on: boolean) => http<Task>(`/chat/tasks/${id}/focus`, { method: 'POST', body: { on, ...dayWindow() } }),
  addStep: (id: string, text: string, isRequired = false) => http<TaskDetails>(`/chat/tasks/${id}/checklist`, { method: 'POST', body: { text, isRequired } }),
  updateStep: (id: string, itemId: string, b: Partial<{ isDone: boolean; text: string; isRequired: boolean }>) =>
    http<TaskDetails>(`/chat/tasks/${id}/checklist/${itemId}`, { method: 'PATCH', body: b }),
  removeStep: (id: string, itemId: string) => http<TaskDetails>(`/chat/tasks/${id}/checklist/${itemId}`, { method: 'DELETE' }),
  accept: (id: string) => http<Task>(`/chat/tasks/${id}/accept`, { method: 'POST', body: {} }),
  decline: (id: string, reason: string) => http<Task>(`/chat/tasks/${id}/decline`, { method: 'POST', body: { reason } }),
  requestDate: (id: string, dueUtc: string, reason: string) => http<Task>(`/chat/tasks/${id}/request-date`, { method: 'POST', body: { dueUtc, reason } }),
  answerDate: (id: string, approve: boolean, reason?: string) => http<Task>(`/chat/tasks/${id}/date-request`, { method: 'POST', body: { approve, reason } }),
  submit: (id: string, note?: string) => http<Task>(`/chat/tasks/${id}/submit`, { method: 'POST', body: { note: note || null } }),
  review: (id: string, approve: boolean, comment?: string) => http<Task>(`/chat/tasks/${id}/review`, { method: 'POST', body: { approve, comment: comment || null } }),
  comment: (id: string, body: string) => http<TaskDetails>(`/chat/tasks/${id}/comments`, { method: 'POST', body: { body } }),
  /** Give one of my own tasks to colleagues (it moves to "Assigned by me"); returns the first copy. */
  assignExisting: (id: string, assigneeIds: string[], requiresReview: boolean) => http<Task>(`/chat/tasks/${id}/assign`, { method: 'POST', body: { assigneeIds, requiresReview } }),
  nudge: (id: string) => http<Task>(`/chat/tasks/${id}/nudge`, { method: 'POST', body: {} }),
  uploadFile: (id: string, file: File, onProgress?: (f: number) => void) =>
    uploadFile(`/chat/tasks/${id}/files`, file, {}, onProgress) as unknown as Promise<TaskDetails>,
  removeFile: (fileId: string) => http<void>(`/chat/task-files/${fileId}`, { method: 'DELETE' }),
  fileUrl: (fileId: string, inline = false) => `${API_BASE}/chat/task-files/${fileId}${inline ? '?inline=1' : ''}`,
  noteShares: (id: string) => http<{ items: NoteShare[] }>(`/chat/notes/${id}/shares`),
  shareNote: (id: string, userIds: string[]) => http<{ items: NoteShare[] }>(`/chat/notes/${id}/shares`, { method: 'PUT', body: { userIds } }),
}
