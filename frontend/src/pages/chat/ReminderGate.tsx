import { lazy, Suspense } from 'react'
import { useChat } from './ChatProvider'

const ReminderCenter = lazy(() => import('./work/ReminderCenter'))
const TaskAlerts = lazy(() => import('./work/TaskAlerts'))

/** Loads the reminder popups (and V033 live task alerts) only for people with Chat and the CHAT_TASKS switch on (nothing otherwise). */
export function ReminderGate() {
  const chat = useChat()
  const on = !!(chat.status?.enabled && chat.status.tasks)
  return on ? (
    <Suspense fallback={null}>
      <ReminderCenter />
      {chat.status?.enabled && chat.status.taskCollab && <TaskAlerts />}
    </Suspense>
  ) : null
}
