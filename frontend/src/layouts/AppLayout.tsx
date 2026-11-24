import { useEffect, useState } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { AnimatePresence, motion } from 'motion/react'
import { cn } from '../lib/cn'
import { Header } from './Header'
import { MobileTabBar } from './MobileTabBar'
import { Sidebar } from './Sidebar'
import { ChatProvider } from '../pages/chat/ChatProvider'
import { loadPhotos } from '../lib/photos'
import { CallProvider } from '../pages/chat/CallProvider'
import { ReminderGate } from '../pages/chat/ReminderGate'

const COLLAPSE_KEY = 'oic.sidebar.collapsed'

export function AppLayout() {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSE_KEY) === '1'
    } catch {
      return false
    }
  })
  const [drawer, setDrawer] = useState(false)
  const { pathname } = useLocation()
  const chatWide = pathname === '/chat'

  useEffect(() => setDrawer(false), [pathname])
  useEffect(() => void loadPhotos(), []) // profile pictures for every avatar (24 Nov 2026)
  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0')
    } catch {
      /* storage unavailable: preference simply isn't remembered */
    }
  }, [collapsed])

  return (
    // Chat's live connection (does nothing unless the CHAT switch is on and the user has chat.use).
    <ChatProvider>
    {/* Audio calls (ringing popup, call panel) on every page; nothing unless CHAT_CALLS is on. */}
    <CallProvider>
    <div className="flex min-h-dvh bg-canvas">
      {/* Desktop sidebar */}
      <aside
        className={cn(
          'sticky top-0 hidden h-dvh shrink-0 transition-[width] duration-[220ms] ease-[cubic-bezier(0.22,1,0.36,1)] lg:block',
          collapsed ? 'w-[76px]' : 'w-[264px]',
        )}
      >
        <Sidebar collapsed={collapsed} onToggle={() => setCollapsed((c) => !c)} />
      </aside>

      {/* Mobile drawer */}
      <AnimatePresence>
        {drawer && (
          <>
            <motion.div
              className="fixed inset-0 z-40 bg-navy-950/50 backdrop-blur-[2px] lg:hidden"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setDrawer(false)}
            />
            <motion.aside
              role="dialog"
              aria-modal="true"
              aria-label="Navigation"
              className="fixed inset-y-0 left-0 z-50 w-[280px] max-w-[85vw] shadow-overlay lg:hidden"
              initial={{ x: '-100%' }}
              animate={{ x: 0 }}
              exit={{ x: '-100%' }}
              transition={{ duration: 0.26, ease: [0.22, 1, 0.36, 1] }}
            >
              <Sidebar collapsed={false} onToggle={() => {}} mobile onClose={() => setDrawer(false)} />
            </motion.aside>
          </>
        )}
      </AnimatePresence>

      <div className="flex min-w-0 flex-1 flex-col">
        <Header onOpenMenu={() => setDrawer(true)} />
        {/* Phones: room at the bottom for the tab bar (+ the iOS home indicator). */}
        {/* Chat (24 Nov 2026): on computers the workspace uses the whole window with a 10 px margin. */}
        <main className={cn('oic-main flex-1 px-4 py-5 sm:px-6 sm:py-6', chatWide && 'oic-main-chat md:!p-2.5')}>
          <motion.div key={pathname} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }} className={cn('mx-auto max-w-[1440px]', chatWide && 'md:max-w-none')}>
            <Outlet />
          </motion.div>
        </main>
        <MobileTabBar />
        {/* Task and note reminder popups (Phase 4); nothing unless CHAT_TASKS is on. */}
        <ReminderGate />
      </div>
    </div>
    </CallProvider>
    </ChatProvider>
  )
}
