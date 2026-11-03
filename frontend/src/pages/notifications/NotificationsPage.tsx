import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Bell, CheckCheck } from 'lucide-react'
import { notificationsApi, notifyNotificationsChanged, type AppNotification } from '../../api/notifications'
import { errorMessage } from '../../api/types'
import { Button } from '../../components/ui/Button'
import { Card } from '../../components/ui/Card'
import { PageHeader, Pagination } from '../../components/ui/Data'
import { Badge, EmptyState, ErrorState, Skeleton } from '../../components/ui/Feedback'
import { FilterSelect } from '../../components/ui/Form'
import { useToast } from '../../components/ui/Toast'
import { cn } from '../../lib/cn'
import { formatDateTime, formatRelative } from '../../lib/format'
import { useLoader } from '../../lib/useLoader'
import { useTimeZone } from '../meetings/meta'
import { notificationIcon, safeLink } from './notificationMeta'

const PAGE_SIZE = 20

/** /notifications — the full notification centre with paging and a read / unread filter. */
export function NotificationsPage() {
  const tz = useTimeZone()
  const toast = useToast()
  const navigate = useNavigate()
  const [filter, setFilter] = useState<'all' | 'unread'>('all')
  const [page, setPage] = useState(1)
  const [markingAll, setMarkingAll] = useState(false)
  useEffect(() => setPage(1), [filter])

  const list = useLoader(() => notificationsApi.list({ unreadOnly: filter === 'unread', page, pageSize: PAGE_SIZE }), [filter, page], 'Unable to load notifications.')
  const data = list.data

  const markLocal = (id: string) =>
    list.setData((d) => (d ? { ...d, unreadCount: Math.max(0, d.unreadCount - 1), items: d.items.map((x) => (x.id === id ? { ...x, isRead: true } : x)) } : d))

  async function open(n: AppNotification) {
    if (!n.isRead) {
      try {
        await notificationsApi.markRead(n.id)
        markLocal(n.id)
        notifyNotificationsChanged()
      } catch (e) {
        toast.error(errorMessage(e, 'The notification could not be marked as read.'))
      }
    }
    const link = safeLink(n.linkPath)
    if (link) navigate(link)
  }

  async function markRead(n: AppNotification) {
    try {
      await notificationsApi.markRead(n.id)
      markLocal(n.id)
      notifyNotificationsChanged()
    } catch (e) {
      toast.error(errorMessage(e, 'The notification could not be marked as read.'))
    }
  }

  async function markAll() {
    setMarkingAll(true)
    try {
      const r = await notificationsApi.markAllRead()
      toast.success(r.marked ? `${r.marked} notification${r.marked === 1 ? '' : 's'} marked as read.` : 'Everything was already read.')
      notifyNotificationsChanged()
      list.reload()
    } catch (e) {
      toast.error(errorMessage(e, 'The notifications could not be marked as read.'))
    } finally {
      setMarkingAll(false)
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Notifications"
        description="Invitations, reminders, reschedules, cancellations and replies to your meetings."
        actions={
          <Button variant="secondary" leftIcon={<CheckCheck className="size-4" />} loading={markingAll} disabled={!data?.unreadCount} onClick={() => void markAll()}>
            Mark all read
          </Button>
        }
      />
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line p-4 sm:px-5">
          <FilterSelect aria-label="Show" value={filter} onChange={(e) => setFilter(e.target.value as 'all' | 'unread')} className="w-48">
            <option value="all">All notifications</option>
            <option value="unread">Unread only</option>
          </FilterSelect>
          {data && <Badge tone={data.unreadCount ? 'brand' : 'neutral'}>{data.unreadCount} unread</Badge>}
        </div>
        {list.error ? (
          <ErrorState title="Unable to load notifications" description={list.error} onRetry={list.reload} />
        ) : list.loading && !data ? (
          <div className="flex flex-col" aria-busy="true" aria-label="Loading notifications">
            {Array.from({ length: 5 }, (_, i) => (
              <div key={i} className="flex gap-3 border-b border-line px-5 py-4 last:border-b-0">
                <Skeleton className="size-9 rounded-full" />
                <div className="flex flex-1 flex-col gap-1.5">
                  <Skeleton className="h-4 w-1/2" />
                  <Skeleton className="h-3 w-1/3" />
                </div>
              </div>
            ))}
          </div>
        ) : !data?.items.length ? (
          <EmptyState icon={<Bell className="size-6" />} title={filter === 'unread' ? "You're all caught up" : 'No notifications yet'} description="Meeting invitations, reminders and changes appear here." />
        ) : (
          <div className={cn('transition-opacity', list.loading && 'opacity-60')} aria-busy={list.loading}>
            <ul className="divide-y divide-line">
              {data.items.map((n) => {
                const ic = notificationIcon(n.type)
                return (
                  <li key={n.id} className={cn('flex items-start gap-3 px-4 py-3.5 sm:px-5', !n.isRead && 'bg-brand-50/50')}>
                    <span className={cn('mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full', ic.cls)}>{ic.icon}</span>
                    <button type="button" onClick={() => void open(n)} className="min-w-0 flex-1 text-left">
                      <span className={cn('block text-[13.5px] leading-5', n.isRead ? 'text-ink-secondary' : 'font-semibold text-ink')}>{n.title}</span>
                      {n.body && <span className="mt-0.5 block text-[12.5px] leading-5 text-ink-secondary">{n.body}</span>}
                      <span className="mt-1 block text-[11.5px] text-ink-muted" title={formatDateTime(n.createdUtc, tz)}>{formatRelative(n.createdUtc, tz)}</span>
                    </button>
                    {!n.isRead && (
                      <button type="button" onClick={() => void markRead(n)} className="shrink-0 rounded-sm px-2 py-1 text-[12px] font-semibold text-brand-700 hover:bg-brand-50">
                        Mark read
                      </button>
                    )}
                  </li>
                )
              })}
            </ul>
            <Pagination page={page} pageSize={PAGE_SIZE} total={data.total} onPage={setPage} disabled={list.loading} />
          </div>
        )}
      </Card>
    </div>
  )
}
