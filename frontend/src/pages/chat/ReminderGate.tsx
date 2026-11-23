import { lazy, Suspense } from 'react'
import { useChat } from './ChatProvider'

const ReminderCenter = lazy(() => import('./work/ReminderCenter'))
const TaskAlerts = lazy(() => import('./work/TaskAlerts'))
const MessageAlerts = lazy(() => import('./MessageAlerts'))

/**
 * Live popups on every portal page, loaded only for people with Chat: new chat messages (23 Nov 2026) for everyone with
 * Chat; reminders with the CHAT_TASKS switch; task alerts with TASK_COLLAB. Message and task banners share one stack at
 * the top (right on computers) so they never cover each other.
 */
export function ReminderGate() {
  const chat = useChat()
  if (!chat.status?.enabled) return null
  const tasks = !!chat.status.tasks
  return (
    <Suspense fallback={null}>
      {tasks && <ReminderCenter />}
      <div className="ios pointer-events-none fixed inset-x-2 top-[max(0.5rem,env(safe-area-inset-top))] z-[67] flex flex-col items-stretch gap-2 sm:inset-x-auto sm:right-3 sm:items-end" data-testid="live-banners">
        <MessageAlerts />
        {tasks && chat.status.taskCollab && <TaskAlerts />}
      </div>
    </Suspense>
  )
}
