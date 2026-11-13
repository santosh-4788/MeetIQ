# Session management

**Audience:** OneInsure Connect operators and developers. **In effect from:** 13 Nov 2026.

## Policy

- **No idle sign-out during the working day.** An employee who leaves the portal open is not signed out for inactivity.
- **Daily forced logout at 23:30 Asia/Kolkata.** A warning appears 5 minutes before, at 23:25. At 23:30 every employee session ends.
- Sessions also end on sign-out, password change or reset, account deactivation or lock, and revocation by an administrator.
- **Guests and customers** in meetings use invitation tokens, not portal sessions, so the daily logout does not affect them.

## Why users were being signed out

Two 30-minute idle limits applied:
- the browser's own timer (`SESSION_IDLE_MINUTES = 30` in `frontend/src/config.ts`);
- the server's sliding window (`Security:SessionIdleMinutes = 30`).

Anyone who did not click or type for 30 minutes outside a meeting was signed out. Before that, sessions also had a fixed 18-hour lifetime.

## How it works now

| Setting / code | Value / behaviour |
|---|---|
| `Security:SessionIdleMinutes` | **0** = no idle timeout. Set in `deploy\api\appsettings.json`; the code default is also 0. |
| `Security:DailyLogout` | `Enabled: true`, `Time: "23:30"`, `TimeZoneId: "Asia/Kolkata"`, `WarningMinutes: 5` |
| New session (`AuthService.CreateSessionAsync`) | `AbsoluteExpiryUtc` = the **next 23:30 IST cutoff**. `ExpiresUtc` = the same, because there is no idle window. "Remember me" makes the cookie persistent until that cutoff. |
| Every request (`SessionAuthenticationHandler`) | The session must be unrevoked and unexpired, and created after the latest cutoff (or a due test cutoff). This is enforced on the **server**. |
| `DailyLogoutService` | Every 30 s, marks pre-cutoff sessions revoked (`RevokedReason = 'DAILY_LOGOUT'`) |
| Browser (`AuthContext.tsx`) | The idle timer runs only if the server reports `idleMinutes > 0` (it reports 0). It shows the 23:25 countdown and ends the portal session at 23:30. |
| Meetings | A session that ends during a call **does not drop the call**. Media and recording run on the server. Host-only portal actions need a fresh sign-in, and the room offers it. |

Only if `DailyLogout` were disabled would `SessionAbsoluteHours` and `RememberMeDays` apply again.

## Testing the 23:25 / 23:30 behaviour without waiting

An administrator with `admin.ops` can schedule a test cutoff for **their own sessions only**:
- `POST /api/v1/admin/ops/daily-logout/test` `{ "minutes": 2 }`, and `DELETE` to cancel.
- This is an API call while signed in. There is no button for it in the portal yet.

The warning appears and the logout happens a few minutes later. The real 23:30 schedule and other users are not affected, and the test is audited (`DAILY_LOGOUT_TEST_SCHEDULED`).

## Evidence

- **API test** `Sessions_have_no_idle_timeout_and_end_at_the_next_daily_logout` checks that:
  - the server reports `idleMinutes 0`;
  - idle and absolute expiry both equal the next 23:30 IST;
  - a session with 3 hours of inactivity is still accepted.
- **Browser test** `enhancements-1112.mjs` EN-01 checks that the portal reports `idleMinutes 0` after sign-in.
- The existing `DailyLogoutTests` cover the warning, the cutoff and test mode.
