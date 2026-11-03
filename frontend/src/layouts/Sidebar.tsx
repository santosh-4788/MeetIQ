import { NavLink } from 'react-router-dom'
import { motion } from 'motion/react'
import { LogOut, PanelLeftClose, PanelLeftOpen, X } from 'lucide-react'
import { ConnectLogo, ConnectMark } from '../components/brand/ConnectLogo'
import { OneInsureLogo } from '../components/brand/OneInsureLogo'
import { useAuth } from '../auth/AuthContext'
import { cn } from '../lib/cn'
import { navigation } from './navigation'

type Props = { collapsed: boolean; onToggle: () => void; mobile?: boolean; onClose?: () => void }

export function Sidebar({ collapsed, onToggle, mobile, onClose }: Props) {
  const { can, signOut } = useAuth()
  const narrow = collapsed && !mobile
  return (
    <div className="flex h-full flex-col bg-navy-900 text-white">
      <div className={cn('flex h-16 shrink-0 items-center border-b border-white/8', narrow ? 'justify-center px-2' : 'justify-between px-5')}>
        {narrow ? <ConnectMark size={36} /> : <ConnectLogo tone="light" size={34} />}
        {mobile && (
          <button onClick={onClose} aria-label="Close menu" className="flex size-9 items-center justify-center rounded-md text-white/70 hover:bg-white/10 hover:text-white">
            <X className="size-5" />
          </button>
        )}
      </div>

      <nav aria-label="Main" className="scrollbar-thin flex-1 overflow-x-hidden overflow-y-auto px-3 py-3 [scrollbar-color:rgb(255_255_255/0.15)_transparent]">
        {navigation.map((section) => {
          const items = section.items.filter((i) => !i.permission || can(i.permission))
          if (!items.length) return null
          return (
            <div key={section.title} className="mb-3">
              {narrow ? (
                <div className="mx-auto mb-2 h-px w-6 bg-white/10" />
              ) : (
                <p className="eyebrow mb-1.5 px-3 text-white/38">{section.title}</p>
              )}
              <ul className="flex flex-col gap-0.5">
                {items.map((item) => (
                  <li key={item.to}>
                    <NavLink
                      to={item.to}
                      onClick={mobile ? onClose : undefined}
                      className={({ isActive }) =>
                        cn(
                          'group/nav relative flex h-9 items-center gap-3 rounded-md text-[13.5px] font-medium transition-colors duration-150',
                          narrow ? 'justify-center' : 'px-3',
                          isActive ? 'text-white' : 'text-white/65 hover:bg-white/6 hover:text-white',
                        )
                      }
                    >
                      {({ isActive }) => (
                        <>
                          {isActive && (
                            <motion.span
                              layoutId={mobile ? 'nav-active-m' : 'nav-active'}
                              className="absolute inset-0 rounded-md bg-gradient-to-r from-brand-500/35 to-brand-500/10 ring-1 ring-white/10"
                              transition={{ type: 'spring', stiffness: 500, damping: 40 }}
                            />
                          )}
                          {isActive && <span className="absolute top-2 bottom-2 left-0 w-[3px] rounded-r-full bg-cyan-400" />}
                          <item.icon className={cn('relative size-[18px] shrink-0', isActive ? 'text-cyan-400' : '')} />
                          {!narrow && <span className="relative truncate">{item.label}</span>}
                          {narrow && <Tooltip label={item.label} />}
                        </>
                      )}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </div>
          )
        })}
      </nav>

      <div className="shrink-0 border-t border-white/8 p-3">
        <button
          onClick={() => void signOut('user')}
          className={cn('group/nav relative flex h-10 w-full items-center gap-3 rounded-md text-[13.5px] font-medium text-white/65 transition-colors hover:bg-white/6 hover:text-white', narrow ? 'justify-center' : 'px-3')}
        >
          <LogOut className="size-[18px]" />
          {!narrow && 'Logout'}
          {narrow && <Tooltip label="Logout" />}
        </button>
        {!mobile && (
          <button
            onClick={onToggle}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            className={cn('group/nav relative mt-1 flex h-10 w-full items-center gap-3 rounded-md text-[13px] text-white/45 transition-colors hover:bg-white/6 hover:text-white', narrow ? 'justify-center' : 'px-3')}
          >
            {collapsed ? <PanelLeftOpen className="size-[18px]" /> : <PanelLeftClose className="size-[18px]" />}
            {!narrow && 'Collapse'}
            {narrow && <Tooltip label="Expand sidebar" />}
          </button>
        )}
        {!narrow && (
          <div className="mt-2 flex items-center justify-between gap-2 rounded-md bg-white/4 px-3 py-2">
            <span className="text-[10.5px] leading-tight text-white/45">A platform by</span>
            <OneInsureLogo height={18} />
          </div>
        )}
      </div>
    </div>
  )
}

function Tooltip({ label }: { label: string }) {
  return (
    <span
      role="tooltip"
      className="pointer-events-none absolute left-full z-50 ml-3 rounded-sm bg-navy-950 px-2.5 py-1.5 text-[12px] font-medium whitespace-nowrap text-white opacity-0 shadow-overlay transition-opacity duration-150 group-hover/nav:opacity-100 group-focus-visible/nav:opacity-100"
    >
      {label}
    </span>
  )
}
