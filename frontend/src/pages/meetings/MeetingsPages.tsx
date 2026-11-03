import { useState } from 'react'
import { Route, Routes } from 'react-router-dom'
import { CalendarDays, CalendarPlus, Contact, Video } from 'lucide-react'
import { useAuth } from '../../auth/AuthContext'
import { ButtonLink } from '../../components/ui/Button'
import { PageHeader, Tabs, tabPanelProps } from '../../components/ui/Data'
import { CustomersPanel } from '../customers/CustomersPanel'
import { PlannedModulePage } from '../PlannedModulePage'
import { MeetingDetailPage } from './MeetingDetailPage'
import { EditMeetingPage } from './MeetingForm'
import { MeetingsList } from './MeetingsList'

function Actions({ schedule = '/schedule' }: { schedule?: string }) {
  const { can } = useAuth()
  return (
    <>
      {can('calendar.view') && (
        <ButtonLink to="/calendar" variant="secondary" leftIcon={<CalendarDays className="size-4" />}>
          View calendar
        </ButtonLink>
      )}
      {can('meetings.create') && (
        <ButtonLink to={schedule} leftIcon={<CalendarPlus className="size-4" />}>
          Schedule meeting
        </ButtonLink>
      )}
    </>
  )
}

/** /meetings/* — list, detail (/meetings/:id) and edit (/meetings/:id/edit). */
export function MeetingsRoutes() {
  return (
    <Routes>
      <Route index element={<MyMeetingsPage />} />
      <Route path=":id" element={<MeetingDetailPage />} />
      <Route path=":id/edit" element={<EditMeetingPage />} />
      <Route path="*" element={<PlannedModulePage />} />
    </Routes>
  )
}

function MyMeetingsPage() {
  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="My Meetings" description="Meetings you host, organise or are invited to. Times in IST." actions={<Actions />} />
      <MeetingsList idPrefix="my-meetings" />
    </div>
  )
}

/** /internal — the same list, internal categories only. */
export function InternalMeetingsPage() {
  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Internal Meetings" description="One-to-one, team, department, management, training and review meetings." actions={<Actions />} />
      <MeetingsList group="INTERNAL" idPrefix="internal-meetings" />
    </div>
  )
}

/** /customer-meetings — customer meetings, plus the customer register. */
export function CustomerMeetingsPage() {
  const [tab, setTab] = useState<'meetings' | 'customers'>('meetings')
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Customer Meetings"
        description="PLVC and other customer meetings. Customers join through a personal, expiring link."
        actions={<Actions schedule="/schedule?category=CUSTOMER_PLVC" />}
      />
      <Tabs
        tabs={[
          { id: 'meetings', label: 'Meetings', icon: <Video className="size-4" /> },
          { id: 'customers', label: 'Customers', icon: <Contact className="size-4" /> },
        ]}
        value={tab}
        onChange={setTab}
        label="Customer meetings sections"
        idPrefix="customer-section"
      />
      <div {...tabPanelProps('customer-section', tab)} className="outline-none">
        {tab === 'meetings' ? <MeetingsList group="CUSTOMER" idPrefix="customer-meetings" /> : <CustomersPanel />}
      </div>
    </div>
  )
}
