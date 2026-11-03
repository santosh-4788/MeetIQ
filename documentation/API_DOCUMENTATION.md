# OneInsure Connect API (v1)

Base path `/api/v1`. JSON in and out. ASP.NET Core 10 (`backend/src/OneInsure.Connect.Api`). Status: Phase 2.

## Conventions

- **Authentication:** server-side session in the `oic_session` cookie (HttpOnly, SameSite=Strict, Secure in production). Idle timeout 30 min; absolute limit 12 h, or 7 days with "remember me".
- **CSRF:** every non-GET request must send the `X-XSRF-TOKEN` header with the value of the `XSRF-TOKEN` cookie. The cookie is issued on any API response that lacks it. Browsers' `Origin` must be the site itself (or `Security:AllowedOrigins`). `frontend/src/api/http.ts` already does this.
- **Errors:** RFC 9457 problem JSON with `code`: `INVALID_CREDENTIALS`, `ACCOUNT_LOCKED` (+`lockedUntilUtc`), `ACCOUNT_DISABLED`, `INVALID_MFA_CODE`, `MFA_EXPIRED`, `INVALID_RESET_TOKEN`, `PASSWORD_POLICY` (+`violations[]`), `VALIDATION` (+`errors: {field: message}`), `CONFLICT` (409), `NOT_FOUND` (404), `RATE_LIMITED` (429), `UNAUTHORIZED` (401), `FORBIDDEN` (403), `SERVER`.
- **Ids:** employees and users are addressed by `id` (GUID PublicId); masters by `code` (upper-case, immutable). Internal database ids never appear.
- **Paging:** `?page=1&pageSize=25` → `{ items, total, pageNumber, pageSize }`.
- **Permissions:** shown per endpoint. A user flagged `mustChangePassword` can only use `/auth/me`, `/auth/change-password` and `/auth/logout` until the password is changed.
- **Audit:** every write is recorded in `app.AuditLog`. Security-relevant writes are flagged as privileged.

## Auth — `/auth`

| Method & path | Body | Result |
|---|---|---|
| POST `/auth/login` | `{login, password, rememberMe}` (`login`: e-mail or employee code) | `{status:"SUCCESS"\|"PASSWORD_CHANGE_REQUIRED", user}` or `{status:"MFA_REQUIRED", mfaToken, methods:["TOTP"]}` |
| POST `/auth/mfa/verify` | `{mfaToken, code, method:"TOTP"\|"RECOVERY_CODE", rememberDevice}` | `UserSummary`. `rememberDevice` skips MFA in this browser for 30 days |
| POST `/auth/mfa/resend` | | 400: e-mail codes are not available yet (no SMTP) |
| GET `/auth/me` | | `UserSummary` |
| POST `/auth/logout` | | 204 |
| POST `/auth/change-password` | `{currentPassword, newPassword}` | 204. Other sessions are revoked |
| POST `/auth/forgot-password` | `{login}` | 204 always. The e-mail is queued in `app.EmailOutbox` |
| POST `/auth/reset-password` | `{token, newPassword}` | 204. Single use; all sessions revoked |

`UserSummary`: `{id, displayName, email, employeeCode, department, designation, roles[], permissions[], timeZone, mustChangePassword}`.
Password policy: 12–128 characters, upper and lower case, digit, symbol, and must not contain the e-mail name or employee code.
Lockout: 5 failed passwords or MFA codes → locked for 15 minutes.

## Account (signed-in user) — `/account`

| Method & path | Body | Result |
|---|---|---|
| GET `/account/mfa` | | `{enabled, methods[], recoveryCodesRemaining, enabledUtc}` |
| POST `/account/mfa/totp/setup` | `{currentPassword}` | `{secret, otpAuthUri, qrCodeDataUrl}`. Scan the QR, or type `secret` into the authenticator app |
| POST `/account/mfa/totp/confirm` | `{code}` | `{recoveryCodes[10]}`, **shown once**. MFA is now on |
| POST `/account/mfa/recovery-codes` | `{code}` | `{recoveryCodes[10]}` (replaces the old codes) |
| POST `/account/mfa/disable` | `{currentPassword, code}` (`code`: TOTP or recovery code) | 204 |
| GET `/account/sessions` | | `[{id, createdUtc, lastSeenUtc, ipAddress, userAgent, current}]` |
| POST `/account/sessions/{id}/revoke` | | 204 |

## Dashboard

GET `/dashboard/summary` (`dashboard.view`) → `DashboardSummary` (frontend/src/api/types.ts).

## Organisation masters — `/org` (read: signed-in user; write: `org.manage`)

| Resource | Fields | Endpoints |
|---|---|---|
| Departments | `code, name, parentCode?, headEmployeeId?` → list adds `headName, employeeCount, isActive` | GET `/org/departments?includeInactive=true`, POST, PUT `/{code}`, POST `/{code}/activate`\|`/deactivate` (409 while active employees remain) |
| Designations | `code, name, level?` (0–100) → `+employeeCount, isActive` | same pattern (`/org/designations`) |
| Branches | `code, name, city?, state?, timeZoneId?` (IANA, default Asia/Kolkata), `address?` | same pattern (`/org/branches`) |
| Teams | `code, name, departmentCode, teamLeaderId?` → `+departmentName, teamLeaderName, memberCount` | same pattern (`/org/teams`); GET/PUT `/org/teams/{code}/members` `{employeeIds[]}` (history kept) |

POST returns 201 `{code}`. PUT returns 204 (`code` cannot change).

## Employees — `/employees` (`employees.manage`, except `lookup`)

| Method & path | Notes |
|---|---|
| GET `/employees?search=&department=&designation=&branch=&status=active\|inactive\|all&sort=name\|code\|joined\|department&page=&pageSize=` | Paged list: `id, employeeCode, firstName, lastName, displayName, officialEmail, mobile, departmentCode, department, designationCode, designation, branchCode, branch, reportingManagerId, reportingManagerName, dateOfJoining, isActive, hasUserAccount` |
| GET `/employees/lookup?search=` | Any signed-in user. Top 20 active employees: `id, employeeCode, displayName, department, designation` |
| GET `/employees/{id}` | `{employee, teams[], userAccount?{id,email,isActive,mfaEnabled,lastLoginUtc,roles}, directReports}` |
| POST `/employees` | `{employeeCode, firstName, lastName?, displayName?, officialEmail, mobile?, departmentCode, designationCode, branchCode?, reportingManagerId?, dateOfJoining? (yyyy-MM-dd)}` → 201 `{id}`. Reporting loops are rejected |
| PUT `/employees/{id}` | Same body (`employeeCode` cannot change) → 204 |
| POST `/employees/{id}/deactivate` | Also disables the linked user account, revokes its sessions and ends team memberships. Not allowed on yourself |
| POST `/employees/{id}/activate` | The user account stays disabled until an administrator re-enables it |
| GET `/employees/import/template` | CSV header row |
| POST `/employees/import` | `{csv, dryRun}`. Upserts by EmployeeCode. All-or-nothing: nothing is applied if any row has errors. Columns: `EmployeeCode, FirstName, LastName, DisplayName, OfficialEmail, Mobile, DepartmentCode, DesignationCode, BranchCode, ReportingManagerCode, DateOfJoining`. Response `{applied, dryRun, summary{total,created,updated,failed}, rows[{row, employeeCode, action:"CREATE"\|"UPDATE"\|"ERROR", errors{}}]}`. Limits: 2 MB, 5,000 rows |

## Users & roles — `/admin` (`users.manage`; matrix edits `roles.manage`)

| Method & path | Notes |
|---|---|
| GET `/admin/users?search=&status=active\|inactive\|locked\|all&page=` | `id, email, displayName, employeeCode, employeeId, department, roles[], isActive, isLocked, mfaEnabled, mustChangePassword, lastLoginUtc` |
| POST `/admin/users` | `{email?, employeeId?, roles[]}` (e-mail defaults to the employee's official e-mail) → 201 `{id, email, oneTimePassword}`, **shown once**; must be changed at first sign-in |
| PUT `/admin/users/{id}/roles` | `{roles[]}` |
| POST `/admin/users/{id}/reset-password` | → `{oneTimePassword}`. Revokes sessions |
| POST `/admin/users/{id}/unlock` \| `/reset-mfa` \| `/deactivate` \| `/activate` | 204 |
| GET `/admin/roles` | `[{code, name, description, isSystem, userCount, permissions[]}]` |
| GET `/admin/permissions` | `[{code, module, description}]` |
| PUT `/admin/roles/{code}/permissions` | `{permissions[]}` (`roles.manage`) |

Guards:
- Granting SuperAdmin, or acting on another SuperAdmin's account, needs `roles.manage`.
- You cannot remove your own SuperAdmin role or deactivate yourself.
- At least one active SuperAdmin always remains.
- SuperAdmin keeps `roles.manage`.
- The recording permissions beyond `recordings.view.own` exist but are unassigned until Compliance approves the access matrix.

## Operations

- `GET /health` → `{status:"Healthy"}` or 503. No details.
- `setup-admin --email <e-mail>` (command line, not HTTP): creates the first SuperAdmin with a one-time password.
- Configuration: `ConnectionStrings:OneInsure` (user secrets / environment only), `Security:*`, `PublicEndpoints:WebBaseUrl`, `DataProtection:KeysPath` (production; back it up, because it encrypts the MFA secrets).

---

# Phase 3 — meetings, calendar, availability, invitations, reminders, notifications

All times are UTC in and out (ISO 8601 with `Z`). E-mails and notification texts show times in the meeting's time zone (default `Asia/Kolkata`, shown as IST). Meetings, customers, notifications and availability entries are addressed by PublicId (`id`); meeting participants by an opaque participant `id`. Migration `V011__phase3_meetings.sql` adds the `RESPONSE` notification type and PublicIds on `mtg.MeetingNotifications` and `mtg.EmployeeAvailability`.

## Customers — `/customers` (`customer.meetings.view`)

| Method & path | Notes |
|---|---|
| GET `/customers?search=&assignedToMe=true&includeInactive=true&page=&pageSize=` | Paged: `id, customerRef, fullName, email (masked), mobile (masked), policyNumber, referenceNumber, assignedEmployeeId, assignedEmployeeName, isActive`. `search` matches name, reference, policy/reference number (partial) or exact e-mail/mobile |
| GET `/customers/{id}` | Full record (unmasked contact, `notes`, `meetingCount`) |
| POST `/customers` | `{customerRef, fullName, email?, mobile?, policyNumber?, referenceNumber?, assignedEmployeeId?, notes?}` → 201 `{id}`. At least one of e-mail/mobile. `customerRef` unique (upper-cased) → 409 |
| PUT `/customers/{id}` | Same body → 204 (full replace) |

Audit entries for customers never contain names, e-mail addresses or mobile numbers.

## Meetings — `/meetings`

| Method & path | Permission | Notes |
|---|---|---|
| GET `/meetings?scope=mine\|hosting\|attending\|all&status=&category=&from=&to=&search=&sort=asc\|desc&page=&pageSize=` | `meetings.view.own` or `.all` | `all` needs `meetings.view.all` (403). `category` = a DB category or `CUSTOMER`/`INTERNAL`. `from`/`to` filter by overlap. Items: `id, meetingCode, title, category, categoryGroup, status, startUtc, endUtc, timeZoneId, organiser, hostId, participants[] (first 10 names), participantCount, recording, recordingPolicy, customerName, myRole, myResponse`. `categoryGroup` is the dashboard's `MeetingSummary.category` |
| GET `/meetings/{id}` | same | Meeting + `host`, `createdBy`, `customer?`, `participants[{id, type, employeeId, name, department, email (guests, editors only), role, responseStatus, isRequired, invitation?{status: ACTIVE\|REVOKED\|EXPIRED, createdUtc, expiresUtc, useCount, lastUsedUtc}}]`, `reminders{pending, sent, failed, cancelled, nextDueUtc}` (current schedule), `my{participantId, role, responseStatus, isHost, isOrganiser, canEdit, canCancel, canRespond}` |
| POST `/meetings` | `meetings.create` (+`customer.meetings.view` for customer categories) | See body below → 201 `{id, meetingCode, status, warnings[], overriddenConflicts}` |
| PUT `/meetings/{id}` | `meetings.create`; host, organiser or `meetings.view.all` | `{title, description?, agenda?, category?, startUtc, endUtc, timeZoneId?, recordingPolicy?, waitingRoomEnabled?, status? (DRAFT→SCHEDULED only), purpose?, policyNumber?, overrideConflicts?, overrideReason?}` → 200 `{id, status, rescheduled, warnings[], overriddenConflicts}`. Host, customer and the customer/internal family cannot change |
| POST `/meetings/{id}/cancel` | same | `{reason}` (required) → 204. Draft or scheduled meetings only |
| POST `/meetings/{id}/respond` | `meetings.view.own` or `.all` | `{response: ACCEPTED\|DECLINED\|TENTATIVE}` → 204. The current user's own participant row; the host cannot decline. Notifies the host (`RESPONSE`) |
| POST `/meetings/{id}/participants` | `meetings.create`, editor | `{employeeIds[], guests[{name, email}], overrideConflicts?, overrideReason?}` → 200 `{added, warnings[], overriddenConflicts}`. New employees are conflict-checked |
| DELETE `/meetings/{id}/participants/{participantId}` | same | 204. Not for the host/organiser or the customer, nor for someone who already joined |
| POST `/meetings/availability` | `meetings.create` | `{employeeIds[] (default: me), startUtc, endUtc, excludeMeetingId?}` → `{available, conflicts[], warnings[]}` (live warnings for the form) |

**Create body:** `{title, description?, agenda?, category, startUtc, endUtc, timeZoneId? (IANA, default Asia/Kolkata), hostEmployeeId? (default: me), employeeIds[], customerId? (required for CUSTOMER_PLVC/CUSTOMER_GENERAL, not allowed otherwise), guests[{name, email}]?, recordingPolicy: NONE|OPTIONAL|REQUIRED (stored only; recording is Phase 4), waitingRoomEnabled? (default true), status: DRAFT|SCHEDULED, purpose?, policyNumber? (default: the customer's), overrideConflicts?, overrideReason?}`.

Rules:
- The signed-in user must be linked to an employee record, otherwise 400 `VALIDATION`. The creator is the permanent owner (`CreatedByEmployeeId`). Host and creator are `HOST` participants (`ACCEPTED`); other employees, the customer and guests are `ATTENDEE` (`PENDING`).
- `end > start`, at most `Meetings:MaxDurationHours` (8) hours, start not in the past (drafts excepted). `MeetingCode` = `OIC-YYMMDD-XXXX` (IST date of creation, random suffix, retried on collision). The LiveKit room name is random and never shown.
- **Visibility:** host, creator, participant (not for drafts) or `meetings.view.all`. Anything else is **404**, also for writes. Visible but not editable → 403.
- **Double booking:** scheduling, rescheduling and adding employees run in one SERIALIZABLE transaction: `mtg.usp_LockEmployeesForBooking` (app lock per employee) then `mtg.usp_CheckAvailability` for every employee participant. Conflicts (other scheduled/live meetings where the employee is host or a non-declined participant, `LEAVE`, `BLOCKED`) → 409 `CONFLICT` with `conflicts: [{employeeId, employeeName, type: MEETING|LEAVE|BLOCKED, startUtc, endUtc}]` (no titles or leave reasons). `overrideConflicts: true` needs `meetings.override.conflict` (403 otherwise) and `overrideReason`; the reason is stored in `OverrideConflictReason` and a privileged `MEETING_CONFLICT_OVERRIDDEN` audit entry is written. Time outside an employee's `WORKING_HOURS` rules is a non-blocking `warnings[]` entry (`type: OUTSIDE_WORKING_HOURS`).
- **Reschedule** (time change of a scheduled meeting): `ScheduleVersion` + 1, attendee responses reset to `PENDING`, unsent reminders cancelled and re-created, customer/guest join links revoked and re-issued, everyone e-mailed and notified (`RESCHEDULED`).
- **Cancel:** reminders cancelled, join links revoked, everyone e-mailed and notified (`CANCELLED`).
- The acting user receives no e-mail or notification about their own action.

## Invitations and public join page

- On schedule each participant with an e-mail address gets an HTML e-mail via `app.EmailOutbox` (time in the meeting's zone, organiser, meeting code; employees get a link to `/meetings/{id}`).
- Customers and guests get a personal link `{PublicEndpoints:WebBaseUrl}/join/{token}`: 256-bit random token, only its SHA-256 is stored (`mtg.MeetingInvitations`), expires `Meetings:InvitationGraceDays` (1) day after the scheduled end. Revoked on cancel/removal, re-issued on reschedule. Customers with a mobile number only get no link (SMS is not part of Phase 3).
- GET `/join/{token}` — **anonymous**, rate-limited per IP (`Meetings:JoinPermitPerMinute`, 30/min) → `{title, organiser, startUtc, endUtc, timeZoneId, status: SCHEDULED|LIVE|CANCELLED|ENDED, meetingCode, waitingRoom, joinableNow, joinOpensUtc}`; 404 `NOT_FOUND` for unknown, expired or revoked tokens. `joinableNow` = scheduled/live and from `Meetings:JoinEarlyMinutes` (15) before start until the end. Joining the call is Phase 4.

## Reminders

- On schedule: one `mtg.MeetingReminders` row per participant × offset (`Reminders:OffsetsMinutes`, default `[1440, 60, 15]`; offsets already past and declined participants are skipped) × channel (`IN_APP` for employees with an active user account, `EMAIL` for anyone with an e-mail address). The unique key (meeting, participant, offset, channel, schedule version) prevents duplicates.
- `ReminderWorker` (background service, every `Reminders:PollSeconds`) claims due rows with `mtg.usp_ClaimDueReminders` (lease; cancelled meetings and stale schedule versions are never claimed) and, in one transaction, creates the in-app notification or queues the e-mail (`app.EmailOutbox.RelatedReminderId` is unique, so a retry cannot send twice) and marks the row `SENT`. Failures → `FAILED` with exponential back-off (1, 2, 4 … min) up to `Reminders:MaxAttempts`. Declining cancels the participant's reminders; accepting again restores those still ahead. Customer/guest reminder e-mails point to the link in the invitation (the raw token is not kept).

## Notifications — `/notifications` (`notifications.view`)

| Method & path | Notes |
|---|---|
| GET `/notifications?unreadOnly=true&page=&pageSize=` | Newest first: `{items[{id, type, title, body, linkPath, isRead, createdUtc, readUtc}], total, pageNumber, pageSize, unreadCount}`. Types: `INVITATION, RESCHEDULED, CANCELLED, REMINDER, RESPONSE` (+ Phase 4/5 types). `linkPath` is app-relative, e.g. `/meetings/{id}` |
| GET `/notifications/unread-count` | `{unreadCount}` (bell badge) |
| POST `/notifications/{id}/read` | 204; 404 for someone else's notification |
| POST `/notifications/read-all` | `{marked}` |

Created for employee participants with a user account on invitation, reschedule, cancel and removal, for the host on RSVP answers, and by the reminder worker.

## Calendar — `/calendar` (`calendar.view`)

GET `/calendar?from=&to=&employeeId=&department=&category=&includeCancelled=true` — `from`/`to` required, at most `Meetings:MaxCalendarDays` (62) days. Default: the current user's calendar. Another employee (`employeeId`) or a whole department (`department` code) needs `meetings.view.all` (403 for another employee otherwise; without it `department` only filters the user's own meetings by meeting department). Response `{fromUtc, toUtc, self, items[]}` ordered by start: meetings (`kind: "MEETING", id, meetingCode, title, category, categoryGroup, status, startUtc, endUtc, timeZoneId, isCustomerMeeting, recording, employeeId, employeeName, role, responseStatus`) from `mtg.vw_MeetingCalendar`, plus `LEAVE`/`BLOCKED` periods (`kind, id, title, startUtc, endUtc, reason (own only), employeeId, employeeName`). Drafts appear only for their host/organiser; cancelled meetings only with `includeCancelled=true`.

## My availability — `/account/availability` (`calendar.view`, linked employee required)

| Method & path | Notes |
|---|---|
| GET `/account/availability?from=` | `{timeZoneId, workingHours[{id, dayOfWeek, startLocalTime, endLocalTime}], periods[{id, type, startUtc, endUtc, reason}]}` (periods ending after `from`, default 30 days ago) |
| POST `/account/availability` | `{type: "WORKING_HOURS", dayOfWeek: 0 (Sunday)–6, startLocalTime: "HH:mm", endLocalTime}` or `{type: "LEAVE"\|"BLOCKED", startUtc, endUtc, reason?}` → 201 `{id}`. Several working-hour blocks per day are allowed; local times use the user's time zone |
| PUT `/account/availability/{id}` | Same body → 204 |
| DELETE `/account/availability/{id}` | 204 |

Only the user's own entries; other users' ids are 404.

## Configuration (Phase 3)

`Meetings:{DefaultTimeZone, MaxDurationHours, MaxCalendarDays, JoinEarlyMinutes, JoinPermitPerMinute, InvitationGraceDays}`, `Reminders:{Enabled, OffsetsMinutes[], PollSeconds, BatchSize, MaxAttempts, LeaseSeconds}`. E-mails are only ever queued in `app.EmailOutbox` and delivered by the existing e-mail worker.

# Phase 4 — live video meeting room

Media flows browser ↔ LiveKit SFU directly; the API only issues short-lived LiveKit tokens and performs host actions through LiveKit's RoomService (Twirp, server-side admin token). **An ongoing call never depends on the API or SQL Server:** only join/token, waiting-room, host-action, attendance (webhook) and chat-persistence calls touch SQL. No migration is needed (the V005 tables `WaitingRoomEntries`, `MeetingAttendance`, `MeetingChatMessages`, `app.WebhookEvents` and the `ADMIT_REQUEST` notification type are used as designed).

**Joinable window** (`JoinWindow`): status `SCHEDULED` or `LIVE`, from `Meetings:JoinEarlyMinutes` (15) before the start until `Meetings:JoinLateMinutes` (60) after the scheduled end. Otherwise 409 `CONFLICT` with `reason`: `DRAFT`, `CANCELLED`, `ENDED` (COMPLETED/EXPIRED/INCOMPLETE), `TOO_EARLY` (+ `opensUtc`), `TOO_LATE` (+ `closesUtc`). LiveKit not configured (no `LiveKit:ApiKey/ApiSecret`) → 503 `SERVICE_UNAVAILABLE`; the API still starts.

**Connection object** (returned by every successful join): `{url, token, identity, name, role: HOST|COHOST|ATTENDEE, participantType: EMPLOYEE|CUSTOMER|GUEST, isHost, canPublish, canScreenShare, expiresUtc}` plus `meeting{id, title, meetingCode, category, categoryGroup, status, startUtc, endUtc, timeZoneId, hostName, waitingRoomEnabled}`.

**LiveKit token** (JWT HS256, `iss` = API key, `sub`/`jti` = the participant's `LiveKitIdentity`, `name` = display name, `metadata` = `{"role","type"}`, `nbf` = now − 10 s, `exp` = now + `LiveKit:TokenTtlMinutes` (10): only needed to connect, LiveKit refreshes the token of connected clients). Grants: `roomJoin` to the meeting's `LiveKitRoomName` only, `canSubscribe`, `canPublish` = `MeetingParticipants.CanPublish`, `canPublishSources` = camera + microphone (+ screen_share, screen_share_audio for hosts/co-hosts and participants with `CanScreenShare`), `canPublishData` (chat, raised hands), `roomAdmin` for HOST/COHOST only, `canUpdateOwnMetadata` false. Customers and guests never get `roomAdmin` and have screen share off by default.

## Employees (signed in; `meetings.view.own` or `meetings.view.all`)

| Method & path | Who | Notes |
|---|---|---|
| POST `/meetings/{id}/join` | invited employee participants (hosts included) | → `{connection, meeting}`. Not visible → 404; visible but not a participant (e.g. an administrator with `meetings.view.all`) → 403: administrators cannot enter meetings silently. Creates the LiveKit room (`DepartureTimeoutSeconds`). The first HOST/COHOST join turns `SCHEDULED` → `LIVE` and sets `ActualStartUtc` (`MEETING_STARTED` audit). Every token is audited (`MEETING_JOIN_TOKEN_ISSUED`). Employees never wait in the waiting room |
| GET `/meetings/{id}/chat` | participants | `{items[{identity, name, body, sentUtc, isSystem}]}` — last 200 messages, oldest first (also after the meeting) |
| POST `/meetings/{id}/chat` | participants | `{body}` (1–2000 characters, control characters removed, stored as plain text; the UI renders text only) → 201 message. Meeting must be `SCHEDULED`/`LIVE` (409 otherwise). Live delivery is over LiveKit data (topic `oic.chat`); this call only persists (decision D8) |
| GET `/meetings/{id}/room/waiting` | HOST/COHOST | `{waitingRoomEnabled, items[{id (opaque, Data-Protection), participantId, type, name, enteredUtc}]}` |
| POST `/meetings/{id}/room/waiting/{entryId}/admit` \| `/reject` | HOST/COHOST | 204; 409 when no longer waiting. Audited (`WAITING_ROOM_ADMITTED` / `_REJECTED`); other hosts in the room are told over LiveKit data (topic `oic.waiting`) |
| POST `/meetings/{id}/room/participants/{participantId}/mute` | HOST/COHOST | `{source: MICROPHONE\|CAMERA\|SCREEN_SHARE\|SCREEN_SHARE_AUDIO (default MICROPHONE), trackSid?}` → RoomService `MutePublishedTrack` (track found via `GetParticipant` when no `trackSid`). 404 when not in the room. Audited `ROOM_PARTICIPANT_MUTED` |
| POST `/meetings/{id}/room/participants/{participantId}/remove` | HOST/COHOST | RoomService `RemoveParticipant`. The HOST cannot be removed (409). A removed customer/guest's admission is withdrawn (must wait again). Audited `ROOM_PARTICIPANT_REMOVED` |
| POST `/meetings/{id}/room/end` | HOST/COHOST | End for everyone: RoomService `DeleteRoom` → `COMPLETED`, `ActualEndUtc`, open attendance closed (`MEETING_ENDED`), waiting entries `LEFT`. Audited `MEETING_ENDED`. 409 unless `SCHEDULED`/`LIVE`; 503 when LiveKit is unreachable (nothing changed) |

`participantId` is the participant's opaque id (`LiveKitIdentity`, as in `GET /meetings/{id}` `participants[].id`). `GET /meetings/{id}` also returns `join{joinable, reason, message, opensUtc, closesUtc}` and `my.canJoin`, `my.canHostRoom`; `GET /dashboard/summary` meetings carry `joinable` and `joinOpensUtc`.

## Customers and guests (anonymous; the personal invitation token is the credential)

| Method & path | Rate limit (per IP) | Notes |
|---|---|---|
| GET `/join/{token}` | `Meetings:JoinPermitPerMinute` (30) | (Phase 3) now also `joinClosesUtc, videoAvailable, participantType (CUSTOMER\|GUEST), displayName` |
| POST `/join/{token}/enter` | 30/min | `{displayName?}` (guests only, 1–80 characters; customers always appear under their customer record's name). Counts a link use (`UseCount`, `LastUsedUtc`). Waiting room off → 200 `{status: "ADMITTED", connection, meeting}`. On → 202 `{status: "WAITING", entryId (opaque; carries the chosen name), pollAfterMs: 3000, name, meeting}`; a second call while waiting reuses the entry. New entries notify every HOST/COHOST with an account (`ADMIT_REQUEST`, link `/meetings/{id}/room`) and, live, over LiveKit data. Turned away less than 2 minutes ago → 403 |
| GET `/join/{token}/entry/{entryId}` | `Meetings:WaitingRoomPermitPerMinute` (180) | `{status: WAITING, pollAfterMs}` \| `{status: ADMITTED, connection, meeting}` \| `{status: REJECTED\|LEFT\|ENDED, message}` |
| POST `/join/{token}/entry/{entryId}/leave` | 180/min | 204 — leaves the waiting room (`LEFT`); sent with `keepalive` when the tab closes |
| GET `/join/{token}/chat`, POST `/join/{token}/chat?name=` | 180/min | As the employee chat; only once admitted (or no waiting room), otherwise 403 |

## LiveKit webhooks

POST `/webhooks/livekit` — anonymous, exempt from the XSRF check, authenticated by LiveKit's signature: the `Authorization` header is a JWT (HS256 with the API secret, `iss` = API key, `exp`/`nbf` checked with 60 s skew) whose `sha256` claim must equal the base64 SHA-256 of the exact body. Invalid → 401 (not stored). Valid events are stored once in `app.WebhookEvents` (event `id` = primary key, `Source = 'LIVEKIT'`) and processed under an `UPDLOCK` on that row, so redelivery and concurrent delivery are idempotent (`{duplicate: true}`); a processing error is recorded (`ProcessingError`, `Attempts`) and answered 500 so LiveKit retries.

- `participant_joined` → `mtg.MeetingAttendance` row (`JoinedUtc`, `ClientInfo = livekit:<participant sid>`).
- `participant_left` / `participant_connection_aborted` → closes that session's row (`LeftUtc`, `LeaveReason` = LiveKit's disconnect reason, e.g. `CLIENT_INITIATED`, `PARTICIPANT_REMOVED`, `DUPLICATE_IDENTITY`).
- `room_finished` → open rows closed (`ROOM_FINISHED`), waiting entries `LEFT`, a `LIVE` meeting becomes `COMPLETED` with `ActualEndUtc` (`MEETING_COMPLETED`, actor SYSTEM). LiveKit sends it `LiveKit:DepartureTimeoutSeconds` (120) after the last participant left.
- Identities that are not participants of the meeting (e.g. the hidden recorder) are ignored.

**Development:** LiveKit cannot trust the self-signed https development certificate, so `LiveKit:WebhookListenUrl` (appsettings.Development.json: `http://127.0.0.1:5080`) adds a plain-http listener. Only loopback addresses are accepted, it answers 404 for every path except the webhook, and an instance that finds the port taken skips it (warning in the log). `video-server/start-dev.ps1` appends the `webhook:` block (API key name from `dev.local.env`, never the secret) and passes the config through `LIVEKIT_CONFIG`. Production: LiveKit posts to `https://<app server>/api/v1/webhooks/livekit` over the trusted certificate (INT-4 in NETWORK_FIREWALL_REQUIREMENTS.md); leave `WebhookListenUrl` empty.

## Configuration (Phase 4)

`LiveKit:{PublicUrl (browser signalling URL, dev ws://127.0.0.1:7880), ApiUrl (RoomService, default = PublicUrl with ws→http), ApiKey, ApiSecret (user secrets / environment variables LiveKit__ApiKey, LiveKit__ApiSecret only), TokenTtlMinutes (10), DepartureTimeoutSeconds (120), WebhookListenUrl (dev only)}`, `Meetings:{JoinLateMinutes (60), WaitingRoomPermitPerMinute (180)}`.

---

# Phase 5 — Recording management

The R2 recorder (headless Microsoft Edge + FFmpeg) is a **proof of concept**, started as a separate process by the API's recorder worker. Nothing here claims production readiness. All values in recording policies are configuration; the shipped values are placeholders (see RECORDING_POLICY_CONFIGURATION.md).

## Recording policies — `/admin/recording-policies`

| Method & path | Permission | Notes |
|---|---|---|
| GET `/admin/recording-policies` | `recordings.policy.manage`, `admin.settings` or `audit.view` | `{items: Policy[4], roles: [{code,name}], categories: [{category, policyCode}]}`. Each policy carries `confirmed` (status `EXISTING_BUSINESS_POLICY`/`APPROVED` **and** a policy reference), `hasPlaceholders`, `pending[]` (texts of the "Not confirmed" banner), `configurationOnly` (customer audio calls), `rowVersion` |
| PUT `/admin/recording-policies/{code}` | `recordings.policy.manage` | Full policy body (`policyName, policyVersion, effectiveFrom (yyyy-MM-dd), approvalStatus (PENDING_CONFIRMATION\|EXISTING_BUSINESS_POLICY\|APPROVED), policyReference, approvedBy, approvedOn, isEnabled, requirement (DISABLED\|OPTIONAL\|MANDATORY), consentMode (CONSENT_REQUIRED\|NOTIFICATION_ONLY), noticeText (≤4000), noticeVersion (≤30), consentFromAll, stopOnWithdrawal, retentionDays (1–36500 or null = not set), expiryAction (REVIEW_ONLY\|ARCHIVE\|DELETE), archiveLocation (absolute path; required for ARCHIVE), legalHoldEnabled, dualApprovalForDeletion, deletionApproverRoles[], playbackRoles[], downloadRoles[], ownerCanPlay, ownerCanDownload, teamLeaderCanPlay, departmentHeadCanPlay, signedUrlTtlSeconds (30–3600), rowVersion`). 400 with field errors. A confirmed status is refused while the wording/version are placeholders, retention is empty, or name/version/reference are missing (`APPROVED` also needs approver and date) — checked again by the shared `RecordingPolicyGate.Validate`. Unknown roles → 400. Stale `rowVersion` → 409. Audited `RECORDING_POLICY_UPDATED` (privileged, old + new values) |
| GET `/admin/recording-policies/categories` | as GET above | `[{category, policyCode}]` |
| PUT `/admin/recording-policies/categories` | `recordings.policy.manage` | `{items: [{category, policyCode}]}` — all 9 categories exactly once; customer categories only `CUSTOMER_MEETING`; internal categories never `CUSTOMER_MEETING`; `CUSTOMER_AUDIO_CALL` never (no telephony). Audited `RECORDING_POLICY_CATEGORIES_UPDATED` (privileged) |
| GET `/admin/recording/health` | `admin.ops`, `admin.settings` or `recordings.policy.manage` | `{available, environment, recorder, items: [{name, ok, detail}], activeJobs, queuedJobs, failedLast24h}` — library/spool folders writable, recorder exe present, `ffmpeg -version`/`ffprobe -version` run, Edge present, layout built, LiveKit keys, worker enabled |

## Recording in the meeting room

| Method & path | Who | Notes |
|---|---|---|
| GET `/meetings/{id}/recording` | participant (session) | `{available, unavailableReason, unavailableCode, policy{code, title, name, version, confirmed, requirement (effective), consentMode, noticeText, noticeVersion, consentFromAll, stopOnWithdrawal}, recording{id, status, startedUtc}\|null, lastRecording, myConsent, isHost, canStart, canStop, consent{ok, required, granted, pending[], declined[]} (hosts)}`. A host's call also triggers the automatic start of a MANDATORY recording |
| POST `/meetings/{id}/recording/consent` | participant | `{decision: GRANTED\|DENIED\|WITHDRAWN, noticeVersion}` → append-only `mtg.MeetingConsent` row (notice version, IP, user agent, SHA-256 evidence hash over meeting, participant, decision, wording hash, time, IP and user agent). Old notice version → 409 `NOTICE_CHANGED`. DENIED/WITHDRAWN during a recording stops it when the policy says so. Audited `RECORDING_CONSENT_*` |
| POST `/meetings/{id}/recording/start` | HOST/COHOST | `{acceptNotice: true, noticeVersion}` (records the host's own consent). Refusals: 409 `RECORDING_DISABLED`, `POLICY_NOT_CONFIRMED` (Pilot/Production with an unconfirmed policy), `CONSENT_MISSING` (names who has not consented), `ALREADY_RECORDING`, `NOTICE_CHANGED`; 503 recorder/LiveKit unavailable. Creates `rec.MeetingRecordings` (`PENDING`, owner = meeting creator, policy snapshot) + `rec.RecordingJobs` (`QUEUED`). Audited `RECORDING_STARTED` |
| POST `/meetings/{id}/recording/stop` | HOST/COHOST | Job → `STOPPING` (the recorder finalises), or cancels a job not yet picked up. MANDATORY → 409 `RECORDING_MANDATORY` |
| GET `/join/{token}/recording`, POST `/join/{token}/recording/consent` | customer/guest once admitted | Same as above (no host fields). 403 before admission |

State changes are pushed to everyone in the room: LiveKit room metadata `{"oicRecording": {status, id, startedUtc}}` and a data message on topic `oic.recording`.

## Recording library — `/recordings` (signed in)

Visibility: owner (`recordings.view.own`), team leader of the owner's team (`recordings.view.team` or policy flag), head of the owner's department (`recordings.view.department` or policy flag), `recordings.view.all`, or a role listed in the policy's playback roles. Anything else → **404** and a `DENIED` row in `rec.RecordingAccessLog`.

| Method & path | Notes |
|---|---|
| GET `/recordings?from&to&employee&department&category&status&customerRef&meeting&search&legalHold&page&pageSize` | Paged; `PURGED` hidden unless `status=PURGED`. `category` = DB category or group (CUSTOMER, INTERNAL, TRAINING, REVIEW, MANAGEMENT). Items carry `canPlay`, `canDownload`, `access` (why visible) |
| GET `/recordings/by-employee` | Same filters; per owner: recordings, completed, failed, total seconds/bytes, latest |
| GET `/meetings/{id}/recordings` | Visible recordings of a meeting + `hiddenCount` |
| GET `/recordings/{id}` | Detail: verification JSON, SHA-256, codecs, consent decisions, retention, `canSetLegalHold`, `canRetry`, access history (for `audit.view`, `recordings.view.all`, `recordings.legalhold` or a playback role). Logs `VIEW_DETAILS` |
| GET `/recordings/{id}/access-log` | Access history (same rule) |
| POST `/recordings/{id}/play`, `/recordings/{id}/download` | `{url, expiresUtc}` — signed link valid for the policy's link lifetime and bound to the user. Logs `PLAY`/`DOWNLOAD` with the expiry; refusal → 403 + `DENIED`. Download needs `recordings.download`, a download role of the policy, or (owner) `ownerCanDownload` |
| GET `/recordings/media/{token}` | Streams the MP4 with HTTP range support (206), `Cache-Control: private, no-store`; download links as attachment `recording-<meeting code>-<yyyyMMdd-HHmm>.mp4`. Expired, forged or another user's token → 403 |
| PUT `/recordings/{id}/legal-hold` | `recordings.legalhold` and policy `legalHoldEnabled`. `{hold, reason}`; placing a hold cancels pending deletions. Audited (privileged, old/new) |
| POST `/recordings/{id}/retry` | `admin.ops`; FAILED only → 202. The worker rebuilds each part with `recorder finalize` from the spooled segments and verifies again |
| GET `/recordings/retention` | Review list and deletion requests (auditors, or users whose role is a deletion approver of the policy) |
| POST `/recordings/deletions/{id}/approve`, `/recordings/deletions/{id}/reject` | Approver role from the policy; the requester cannot approve; with dual approval the second approver must be a different person. The final approval deletes the file → `PURGED` (row and history kept). Audited (privileged) |

## Configuration (Phase 5)

`Recording:{Environment (Development|Test|Pilot|Production; appsettings.json: Production, appsettings.Development.json: Development), StorageRoot, SpoolRoot (outside the web root; relative paths are relative to the content root), RecorderExePath, FfmpegPath, FfprobePath, EdgePath (empty = installed Edge), LayoutDistPath, LiveKitUrl (empty = LiveKit:PublicUrl), WorkerEnabled (true), PollSeconds (3), LeaseSeconds (60), StartTimeoutSeconds (120), StopTimeoutSeconds (300), MaxDurationMinutes (240), MaxLaunches (3), KeepSpoolAfterSuccess (false), RetentionEnabled (true), RetentionPollMinutes (60), Width/Height (1280×720), DurationTolerancePercent (3), DurationToleranceMinSeconds (5)}`. The recorder receives the LiveKit keys, tool paths and the meeting's current policy through its process environment (`OIC_Recorder__*`, `OIC_RecordingPolicy__*`), never on its command line.

## Instant meetings and shareable links (Advanced features, Phase B)

| Method | Path | Who | Notes |
|---|---|---|---|
| POST | `/meetings/instant` | `meetings.create`, linked employee | Body: `title?`, `category?` (internal categories only; default `GROUP`), `durationMinutes?` (5 … MaxDurationHours×60; default `Meetings:InstantDefaultMinutes` = 60), `audioOnly?`, `waitingRoomEnabled?` (default true), `recordingPolicy?`. Starts now, no availability check, no e-mails. 201 `{ id, meetingCode, kind: "INSTANT", link }` |
| GET | `/meetings/by-code/{code}` | `meetings.view.own`/`all` | `{ id }` only for meetings the user can already see; otherwise 404 (same answer for "does not exist") |
| GET | `/meetings/{id}/link` | host, co-host or organiser | The active link (created on first request; expiry extended after a reschedule). `{ url, path, createdUtc, expiresUtc, useCount, lastUsedUtc }` |
| POST | `/meetings/{id}/link/regenerate` | same | Old link stops working; returns the new one (audited `MEETING_LINK_REGENERATED`) |
| POST | `/meetings/{id}/link/revoke` | same | 204; no active link (audited `MEETING_LINK_REVOKED`) |
| GET | `/m/{token}` | anonymous (rate limit `join`) | Title, organiser, times, status, `joinableNow`, `locked`, `audioOnly`, `kind`, `participantType` (`GUEST`, or `EMPLOYEE` when signed in), `meetingId` (only when the signed-in user is already an admitted participant). No participant data. 404 explains withdrawn/expired links |
| POST | `/m/{token}/request` | anonymous (rate limit `join`) | Body `{ displayName }` (guests). Creates a participant (`JoinSource = LINK`, `AdmissionRequired = 1`) and returns `{ joinToken, participantType, displayName }`: continue with `/join/{joinToken}/enter` (always WAITING). Signed-in participants get `{ meetingId }`. 403 `LOCKED` when the meeting is locked; 409 when joining is closed or `Meetings:MaxLinkJoiners` (50) is reached |

Changes to existing endpoints: `POST /meetings/{id}/room/participants/{identity}/remove` accepts `{ block: true }` (participant blocked, personal link revoked, audited `ROOM_PARTICIPANT_BLOCKED`); `POST /meetings/{id}/join` answers 403 `ADMISSION_REQUIRED` for a colleague from the link who has not been admitted yet; connections carry `canPublishVideo` (false in audio-only meetings: the camera is not an allowed source in the token); meeting list/detail/room carry `kind` and `audioOnly`; waiting-list entries carry `viaLink`.
