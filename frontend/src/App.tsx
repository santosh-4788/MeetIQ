import { lazy, Suspense, type ReactNode } from 'react'
import { Navigate, Route, Routes, useParams } from 'react-router-dom'
import { MotionConfig } from 'motion/react'
import { AuthProvider, RedirectIfAuthenticated, RequireAuth, RequirePermission } from './auth/AuthContext'
import { ToastProvider } from './components/ui/Toast'
import { AuthLayout } from './layouts/AuthLayout'
import { AppLayout } from './layouts/AppLayout'
import { allNavItems } from './layouts/navigation'
import { LoginPage } from './pages/auth/LoginPage'
import { MfaPage } from './pages/auth/MfaPage'
import { ChangePasswordPage, ForgotPasswordPage, ResetPasswordPage } from './pages/auth/PasswordPages'
import { AccessDeniedPage, AccountLockedPage, SessionExpiredPage } from './pages/auth/StatusPages'
import { DashboardPage } from './pages/DashboardPage'
import { PlannedModulePage } from './pages/PlannedModulePage'
import { AdminPage } from './pages/admin/AdminPage'
import { RecordingsRoutes } from './pages/recordings/RecordingsPage'
import { EmployeesPage } from './pages/employees/EmployeesPage'
import { OrganisationPage } from './pages/org/OrganisationPage'
import { SettingsPage } from './pages/settings/SettingsPage'
import { CalendarPage } from './pages/calendar/CalendarPage'
import { JoinPage } from './pages/JoinPage'
import { LinkJoinPage } from './pages/LinkJoinPage'
import { ScheduleMeetingPage } from './pages/meetings/MeetingForm'
import { CustomerMeetingsPage, InternalMeetingsPage, MeetingsRoutes } from './pages/meetings/MeetingsPages'
import { NotificationsPage } from './pages/notifications/NotificationsPage'
import { RoomLoading } from './pages/room/RoomScreens'

// Phase 4: the video room (LiveKit client + components) is a separate chunk, downloaded only when someone joins.
const EmployeeRoomPage = lazy(() => import('./pages/room/EmployeeRoomPage'))

function LegacyRoomRedirect() {
  const { id = '' } = useParams()
  return <Navigate to={`/meetings/${id}/room`} replace />
}

// Phase 2 and 3 modules. Every other navigation item still renders the honest PlannedModulePage.
const builtPages: Record<string, ReactNode> = {
  '/meetings': <MeetingsRoutes />,
  '/calendar': <CalendarPage />,
  '/schedule': <ScheduleMeetingPage />,
  '/internal': <InternalMeetingsPage />,
  '/customer-meetings': <CustomerMeetingsPage />,
  '/notifications': <NotificationsPage />,
  '/employees': <EmployeesPage />,
  '/organisation': <OrganisationPage />,
  '/admin': <AdminPage />,
  '/recordings': <RecordingsRoutes />,
  '/settings': <SettingsPage />,
}

export default function App() {
  return (
    <MotionConfig reducedMotion="user">
      <AuthProvider>
        <ToastProvider>
          <Routes>
            <Route element={<AuthLayout />}>
              <Route element={<RedirectIfAuthenticated />}>
                <Route path="/login" element={<LoginPage />} />
                <Route path="/forgot-password" element={<ForgotPasswordPage />} />
                <Route path="/reset-password" element={<ResetPasswordPage />} />
                <Route path="/mfa" element={<MfaPage />} />
                <Route path="/account-locked" element={<AccountLockedPage />} />
                <Route path="/session-expired" element={<SessionExpiredPage />} />
              </Route>
              <Route path="/change-password" element={<ChangePasswordPage />} />
              <Route path="/access-denied" element={<AccessDeniedPage />} />
              {/* Public: customers and guests open their e-mailed invitation link without signing in. */}
              <Route path="/join/:token" element={<JoinPage />} />
              {/* Public: the shareable meeting link (anyone can ask to join; a host admits them). */}
              <Route path="/m/:token" element={<LinkJoinPage />} />
            </Route>

            <Route element={<RequireAuth />}>
              {/* Full-screen meeting room, outside the app shell. The API decides who may join. */}
              <Route
                path="/meetings/:id/room"
                element={
                  <Suspense fallback={<RoomLoading />}>
                    <EmployeeRoomPage />
                  </Suspense>
                }
              />
              <Route path="/room/:id" element={<LegacyRoomRedirect />} />
              <Route element={<AppLayout />}>
                <Route path="/dashboard" element={<RequirePermission permission="dashboard.view"><DashboardPage /></RequirePermission>} />
                {allNavItems
                  .filter((i) => i.to !== '/dashboard')
                  .map((i) => (
                    <Route key={i.to} path={`${i.to}/*`} element={<RequirePermission permission={i.permission}>{builtPages[i.to] ?? <PlannedModulePage />}</RequirePermission>} />
                  ))}
                <Route path="*" element={<PlannedModulePage />} />
              </Route>
            </Route>
            <Route path="/" element={<Navigate to="/dashboard" replace />} />
          </Routes>
        </ToastProvider>
      </AuthProvider>
    </MotionConfig>
  )
}
