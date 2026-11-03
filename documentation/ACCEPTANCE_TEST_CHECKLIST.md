# OneInsure Connect: User Acceptance Test Checklist

**Environment:** localhost. Website http://localhost:5173, API https://localhost:7180, database `Oneinsure_v`, LiveKit on this laptop.
**Browsers:** Microsoft Edge and Google Chrome on Windows. Firefox and Safari are not yet verified.
**How to use:**
- Do each step and compare with "Expected".
- Write **P** (pass) or **F** (fail) in the result column, and add a note or screenshot for every F.
- A phase is accepted when all its rows are P, or when every F is fixed and re-tested.

**E-mail:** while testing on localhost, every e-mail goes to **santosh.yadav@oneinsure.com**, with the real recipient shown in the subject as `[to …]`. Links in e-mails work on this laptop only.

## Phase 1: Design, architecture and database ✅ COMPLETED

Accepted on 1 Nov 2026. Architecture and database structure are kept. The documentation and database scripts are up to date:
- DATABASE_DESIGN rev 1.2
- migrations V001–V012, all applied to `Oneinsure_v`
- database/README

---

## Test accounts and data to prepare (once)

| # | Prepare | How |
|---|---|---|
| S1 | **SuperAdmin**: santosh.yadav@oneinsure.com (exists, linked to employee) | — |
| S2 | **Employee**: sagar.kulkarni@oneinsure.com (exists; one-time password given separately) | — |
| S3 | **Admin** user: create an employee + login with role *Admin* | Employee Management → Add; Administration → Users & roles → Create user |
| S4 | **No-role** user: create a login and remove all roles (or give only *Employee* then remove) | Administration → Users & roles |
| S5 | Second department, designation, branch, team | Department Management |
| S6 | A test customer (use your own e-mail) | Customer Meetings → Customers |

Sign in as different users at the same time with **InPrivate windows** (Ctrl+Shift+N) or a second browser.

---

## Phase 2: Sign-in, two-factor, employees, departments, users and roles

### 2.1 Sign-in and passwords
| ID | Step | Expected | P/F | Notes |
|---|---|---|---|---|
| P2-01 | Sign in with e-mail + correct password | Dashboard opens; your name top-right | | |
| P2-02 | Sign in with **employee code** instead of e-mail | Works the same | | |
| P2-03 | Wrong password | "The login ID or password is incorrect." Same message for an unknown e-mail | | |
| P2-04 | Wrong password 5 times (use a test user) | Account locked page with unlock time | | |
| P2-05 | Administration → Users & roles → that user → **Unlock** | User can sign in again | | |
| P2-06 | Sign out (profile menu) | Back to sign-in; browser Back does not show data | | |
| P2-07 | New user signs in with the one-time password | Forced to **Change password**; no other page reachable until changed | | |
| P2-08 | Change password with a weak password (e.g. `abc`) | Rules shown; save refused | | |
| P2-09 | New password containing your name/e-mail | Refused ("must not contain…") | | |
| P2-10 | Valid new password | Saved; other sessions of that user are signed out | | |
| P2-11 | Forgot password → enter e-mail | "If an account exists…" message; reset e-mail arrives (to the test inbox) | | |
| P2-12 | Open the reset link, set a new password, then reuse the same link | First time works; second time "link invalid/expired" | | |
| P2-13 | Leave the browser idle 30 minutes | Session expired page; sign in again | | |

### 2.2 Two-factor authentication
| ID | Step | Expected | P/F | Notes |
|---|---|---|---|---|
| P2-20 | Settings → Two-factor → Turn on → confirm password | QR code + secret shown | | |
| P2-21 | Scan with Microsoft/Google Authenticator, enter the 6-digit code | Two-factor ON; 10 recovery codes shown once (copy/download) | | |
| P2-22 | Sign out and sign in | Asks for 6-digit code; correct code → dashboard | | |
| P2-23 | Wrong code | "The verification code is incorrect." | | |
| P2-24 | Choose **E-mail code** tab | Code arrives by e-mail (test inbox); it works | | |
| P2-25 | "Use a recovery code instead" → one code | Works once; same code a second time is refused | | |
| P2-26 | Tick "Trust this device for 30 days" | Next sign-in on this browser does not ask for a code | | |
| P2-27 | Admin: Users & roles → user → **Reset MFA** | User signs in with password only | | |
| P2-28 | Settings → Active sessions → sign out another session | That browser is signed out | | |

### 2.3 Employees
| ID | Step | Expected | P/F | Notes |
|---|---|---|---|---|
| P2-30 | Employee Management → Add employee with all fields | Saved; appears in list | | |
| P2-31 | Add with an e-mail already used / invalid e-mail / missing department | Field-level error messages | | |
| P2-32 | Edit employee (designation, manager) | Saved; detail shows changes | | |
| P2-33 | Set A's manager = B, then B's manager = A | Second save refused ("reporting loop") | | |
| P2-34 | Search by name, code, e-mail; filter by department/designation/branch/status; sort; page | Results correct | | |
| P2-35 | Open employee detail | Teams, direct reports, linked login shown | | |
| P2-36 | **Deactivate** an employee who has a login and is signed in elsewhere | Confirmation; that person is signed out and cannot sign in | | |
| P2-37 | Activate again | Employee active; login stays disabled until an admin activates it | | |
| P2-38 | **Create user account** from employee detail | One-time password shown once | | |
| P2-39 | Employee whose e-mail already has a login → **Link existing account** | Linked; no error | | |
| P2-40 | CSV import: download template, fill 3 rows (1 with an error), **Check file** | Per-row result; error row explained; Apply not offered | | |
| P2-41 | Fix the error, Check again, **Apply import** | 3 employees created; re-import updates instead of duplicating | | |

### 2.4 Departments, designations, branches, teams
| ID | Step | Expected | P/F | Notes |
|---|---|---|---|---|
| P2-50 | Add department (with parent and head), designation (level), branch (city, time zone), team | All saved | | |
| P2-51 | Add with an existing code | "already exists" | | |
| P2-52 | Edit each; code field is locked | Saved | | |
| P2-53 | Deactivate a department/branch that has active employees | Refused with explanation | | |
| P2-54 | Deactivate an empty one; toggle "Show inactive" | Hidden / shown correctly | | |
| P2-55 | Team → Members: add and remove employees, save | Members list correct | | |

### 2.5 Users, roles and permissions
| ID | Step | Expected | P/F | Notes |
|---|---|---|---|---|
| P2-60 | Administration → Users & roles: search, filter (active/inactive/locked) | Correct results | | |
| P2-61 | Create user (from employee, and from e-mail only) | One-time password shown once | | |
| P2-62 | Edit roles of a user | Saved; user sees new menu after reload | | |
| P2-63 | Reset password of a user | One-time password; that user's sessions end | | |
| P2-64 | Link / change / unlink employee of a login | Works; unlink refused if they host upcoming meetings | | |
| P2-65 | Deactivate / activate a user; try to deactivate yourself | Works; self refused | | |
| P2-66 | As **Admin** (S3): try to give someone SuperAdmin, or reset a SuperAdmin's password | Refused / "Protected" | | |
| P2-67 | Roles matrix as Admin | Read-only | | |
| P2-68 | Roles matrix as SuperAdmin: change a role's permissions, save | Saved; SuperAdmin's `roles.manage` cannot be removed | | |
| P2-69 | Sign in as **Employee** (Sagar) | Menu shows only employee modules; Employee/Department/Administration hidden | | |
| P2-70 | As Employee, type `/admin`, `/employees`, `/organisation` in the address bar | "Access denied" | | |
| P2-71 | Sign in as **no-role** user (S4) | Access denied page with Sign out button (no loop) | | |
| P2-72 | As Sagar, open the URL of a meeting he is not invited to | "Not found" (no data shown) | | |

---

## Phase 3: Meetings, calendar, availability, invitations, reminders and notifications

| ID | Step | Expected | P/F | Notes |
|---|---|---|---|---|
| P3-01 | Schedule Meeting: title, category, date, time, duration, agenda; invite Sagar from **Colleagues** | Saved; meeting code shown | | |
| P3-02 | Sagar's dashboard / My Meetings / Calendar | Meeting appears for Sagar | | |
| P3-03 | Invitation e-mail (test inbox, subject `[to sagar…]`) | Received; IST time, organiser, code, button readable | | |
| P3-04 | Sagar: bell icon | Invitation notification; clicking opens the meeting | | |
| P3-05 | Sagar: Accept / Tentative / Decline | Saved; host gets "replied" notification; host sees status in participants | | |
| P3-06 | Host: Edit → change title/agenda | Saved | | |
| P3-07 | Host: **Reschedule** to another time | Participants notified + new e-mail; replies reset to pending | | |
| P3-08 | Host: add a participant / remove a participant | Works; added person notified | | |
| P3-09 | Host: **Cancel** with reason | Status Cancelled; participants notified + e-mail; join link stops working | | |
| P3-10 | Save as **Draft**, later Schedule it | Draft visible only to you; scheduling sends invitations | | |
| P3-11 | Validation: end before start, past time, no title | Clear messages | | |
| P3-12 | **Double booking**: book Sagar at a time he already has a meeting | Live warning while typing; save refused with conflict list | | |
| P3-13 | Same, as SuperAdmin with "Book anyway" + reason | Allowed; reason recorded | | |
| P3-14 | Sagar: Settings → My availability → add leave tomorrow; host books him then | Shown "On leave"; booking refused | | |
| P3-15 | Working hours set 9–6; book outside | Warning only (allowed) | | |
| P3-16 | Calendar: **Month, Week, Day, Agenda**; Today / previous / next | Meetings in correct days/times (IST); leave shaded | | |
| P3-17 | Click a calendar event | Opens meeting detail | | |
| P3-18 | SuperAdmin: view another employee's calendar | Allowed; as Sagar the option is hidden | | |
| P3-19 | **Customer meeting**: category Customer, pick/add customer (your e-mail), schedule | Customer receives invitation with join link | | |
| P3-20 | Open the customer join link (signed out) | Meeting info page; after reschedule the old link says "rescheduled, use latest" | | |
| P3-21 | **Reminders**: schedule a meeting starting in ~20 minutes | 15-minute reminder: notification + e-mail | | |
| P3-22 | Notifications page: filter unread, mark one read, mark all read | Counts update; bell badge updates (within 60 s) | | |
| P3-23 | Meeting status: before start Scheduled; during the call Live; after end Completed | Dashboard/list/detail show correct status (no "LIVE" after it ended) | | |
| P3-24 | Meeting detail participant list | Names, roles, replies, invitation status correct | | |
| P3-25 | My Meetings tabs: Upcoming, Today, Hosting, Attending, Drafts, Past, Cancelled; search; category filter | Correct lists | | |
| P3-26 | Dashboard KPIs (today, upcoming 7 days, completed this month…) | Match your test data | | |

---

## Phase 4: Video meeting room

Use two browsers or an InPrivate window, with you as host and Sagar as attendee. Optionally add a guest with your own e-mail.

| ID | Step | Expected | P/F | Notes |
|---|---|---|---|---|
| P4-01 | Open a meeting starting within 15 min → **Join meeting** | Pre-join screen: camera preview, mic level, device lists | | |
| P4-02 | Deny camera/mic permission in the browser | Clear help message; can still join without them | | |
| P4-03 | Allow, choose devices, Join | In the room; your video visible | | |
| P4-04 | Sagar joins | Both see and hear each other; names shown | | |
| P4-05 | Mute/unmute mic; camera off/on (each side) | Other side sees the change immediately | | |
| P4-06 | Grid vs speaker layout; active speaker highlight | Works | | |
| P4-07 | **Screen share** (window, tab, entire screen); stop | Other side sees the share; layout switches back | | |
| P4-08 | **Chat**: send messages both ways; include `<b>test</b>` | Delivered instantly; shown as plain text; history visible to a late joiner | | |
| P4-09 | Participants panel | Lists everyone with mic/camera state | | |
| P4-10 | Host: **mute** Sagar; **remove** Sagar | Sagar muted / sees "You were removed" | | |
| P4-11 | **Waiting room**: guest opens the e-mail link, enters name | Guest waits; host sees request (live) | | |
| P4-12 | Host **admits** guest / **rejects** another | Admitted guest enters; rejected sees message | | |
| P4-13 | **Reconnect**: turn Wi-Fi off 10–20 s on one side, then on | "Reconnecting…" then call resumes automatically | | |
| P4-14 | Leave the meeting (non-host) | Leaves; host continues | | |
| P4-15 | Host: **End for all** | Everyone leaves; meeting status Completed; attendance recorded | | |
| P4-16 | Try to join a cancelled / completed meeting, or too early | Clear message; Join not offered | | |
| P4-17 | 3–4 participants (more browsers/laptops on this PC) | All visible; audio clear | | |
| P4-18 | Repeat P4-03…P4-08 in **Chrome** (and Edge) | Same behaviour | | |

Other devices can only join after the LAN test mode is set up (it needs firewall approval). Firefox and Safari have not been verified yet.

---

## Phase R: Recording management

**Before you start:**
1. Go to Administration → Recording policies.
2. Open **Training & team meetings**, switch it **on** and save.
3. Optionally add your role to its playback and download roles.

The wording stays "not confirmed" until your team supplies the approved text.

| ID | Step | Expected | P/F | Notes |
|---|---|---|---|---|
| PR-01 | Administration → **Recording policies** | Four policies: Customer meetings, Customer audio calls, Internal meetings, Training & team; each "Not confirmed" | | |
| PR-02 | Edit each policy (name, version, effective date, requirement, consent mode/wording, retention, roles) and save | Saved; audit entry; status cannot be set to confirmed without a policy reference | | |
| PR-03 | Category mapping: change which meeting category uses which policy | Saved | | |
| PR-04 | Disabled policy → meeting of that category | No Record button | | |
| PR-05 | Team meeting (policy on): everyone in the room sees the **consent notice** | Notice with wording + "not confirmed" flag; Accept / Decline | | |
| PR-06 | Someone declines | Recording cannot start (or stops), per policy | | |
| PR-07 | All accept → host **Start recording** | **REC** indicator for everyone | | |
| PR-08 | During recording: talk, share screen, 3 participants, chat | — | | |
| PR-09 | Host **Stop recording** (or End for all) | Status Recording → Verifying → **Completed** within ~1 minute; owner notified + e-mail | | |
| PR-10 | **Recording Library**: find by meeting, employee, date, category | Listed with duration, size, status | | |
| PR-11 | Play; seek forwards/backwards | Plays smoothly; **audio in sync** with video; screen share visible | | |
| PR-12 | Recording details | Verification result (codecs, duration, checksum) and access history | | |
| PR-13 | **Download** as SuperAdmin with download role / as owner without download right | Allowed / refused | | |
| PR-14 | Sagar (participant, not owner, no permission) opens Library | Recording not visible | | |
| PR-15 | Employee-wise history (by employee) and meeting detail "Recordings" card | Correct | | |
| PR-16 | **Legal hold** on a recording | Shown on hold; retention will not delete it | | |
| PR-17 | Retention: set a test policy to e.g. 1 day + Review only | Expired recordings appear in the review list (after the retention job runs) | | |
| PR-18 | Delete with dual approval: request deletion, approve by a second admin | First approver alone cannot complete; second does; file removed, record kept as Purged | | |
| PR-19 | Access log / audit: views, plays, downloads, denials, deletions, policy changes | All present with user and time | | |
| PR-20 | Customer meeting with recording: customer (guest) sees notice in the room | Customer must accept before recording | | |

**Known limits:**
- The R2 recorder is a proof-of-concept.
- The six-participant recording test failed on this laptop earlier and must be rerun on a server.
- Customer audio calls are configuration only: there is no telephony integration.

---

## Sign-off

| Phase | Tested by | Date | Result (Accepted / Not accepted) | Remarks |
|---|---|---|---|---|
| 1 | — | 1 Nov 2026 | **Accepted** | |
| 2 | | | | |
| 3 | | | | |
| 4 | | | | |
| R | | | | |
