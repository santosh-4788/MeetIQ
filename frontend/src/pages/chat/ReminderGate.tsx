import { lazy, Suspense } from 'react'
import { useChat } from './ChatProvider'

const ReminderCenter = lazy(() => import('./work/ReminderCenter'))

/** Loads the reminder popups only for people with Chat and the CHAT_TASKS switch on (nothing otherwise). */
export function ReminderGate() {
  const chat = useChat()
  const on = !!(chat.status?.enabled && chat.status.tasks)
  return on ? (
    <Suspense fallback={null}>
      <ReminderCenter />
    </Suspense>
  ) : null
}
