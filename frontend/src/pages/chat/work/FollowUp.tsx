import { TaskEditor, type TaskSeed } from './Editors'

/** Where a follow-up comes from. The new task keeps a reference to it (message, chat, call, meeting or note). */
export type FollowUpSource =
  | { kind: 'message'; messageId: string; conversationId: string; title: string; senderName: string | null }
  | { kind: 'conversation'; conversationId: string; title: string }
  | { kind: 'call'; callId: string; conversationId: string | null; title: string }
  | { kind: 'meeting'; meetingId: string; title: string }
  | { kind: 'note'; noteId: string; title: string }

function seedFor(s: FollowUpSource): TaskSeed {
  const short = (t: string) => (t.length > 120 ? `${t.slice(0, 117)}…` : t)
  switch (s.kind) {
    case 'message':
      return { title: `Follow up: ${short(s.title.replace(/\s+/g, ' '))}`, sourceMessageId: s.messageId, conversationId: s.conversationId, messageExcerpt: s.title, messageSender: s.senderName, priority: 'MEDIUM' }
    case 'conversation':
      return { title: `Follow up with ${s.title}`, conversationId: s.conversationId, conversationTitle: s.title }
    case 'call':
      return { title: `Follow up on call with ${s.title}`, sourceCallId: s.callId, conversationId: s.conversationId, callLabel: `Call with ${s.title}` }
    case 'meeting':
      return { title: `Follow up: ${s.title}`, meetingId: s.meetingId, meetingTitle: s.title }
    case 'note':
      return { title: s.title, noteId: s.noteId, noteTitle: s.title }
  }
}

/** "Create task or reminder" from a chat message, a chat, a call, a meeting or a note: the task editor, pre-filled. */
export default function FollowUpSheet({ source, onClose, onSaved }: { source: FollowUpSource; onClose: () => void; onSaved?: () => void }) {
  return <TaskEditor seed={seedFor(source)} onClose={onClose} onSaved={() => onSaved?.()} />
}
