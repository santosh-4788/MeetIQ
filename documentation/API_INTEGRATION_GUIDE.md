# OneInsure Connect — API Integration Guide (v1)

**Audience:** developers of other portals that need to create OneInsure Connect meetings, share the links and collect results from their own interface.

| | |
|---|---|
| Base URL | `https://www.oneinsure.com/meet/api/ext/v1` |
| Format | JSON (UTF-8). Every time is ISO-8601 in India Standard Time (`+05:30`). |
| Version | `v1` (in the path) |
| OpenAPI | `https://www.oneinsure.com/meet/api/ext/openapi/ext-v1.json`: **not public since V025**; it needs a portal sign-in with the `api.docs.view` permission. Also saved as [OPENAPI_SPECIFICATION/oneinsure-connect-ext-v1.openapi.json](OPENAPI_SPECIFICATION/oneinsure-connect-ext-v1.openapi.json), or use **Download OpenAPI (JSON)** on the page. |
| In the portal | Organisation → System → **API Documentation**: the complete guide (every endpoint with parameters, example request and response), an interactive Swagger UI, and, for administrators only, integration and API key management. It is visible to Admin, Super Admin and anyone given the **API Documentation Viewer** role. |

The full endpoint list is in [API_ENDPOINT_REFERENCE.md](API_ENDPOINT_REFERENCE.md).

## 1. Getting access

1. A OneInsure administrator (permission `integrations.manage`) opens **API Documentation → Integrations & API keys → New integration**.
   - They enter the integration name and the portal/application name, choose the scopes and set a rate limit.
2. The system creates a unique **Integration ID** (`INT-XXXXXXXXXX`) and an **API key** (`oic_live_<16 hex>_<secret>`).
   - **The key is shown only once.** Only its SHA-256 hash is stored.
   - Send the key to the portal team over a secure channel.
3. The administrator can later:
   - add a key;
   - **rotate** (issue a new key and revoke all old ones);
   - **revoke** a key, with a reason (it stops working immediately);
   - deactivate the whole integration;
   - change scopes and the rate limit;
   - read the request log and the webhook delivery history.

Every change is audited.

### Scopes

| Scope | Allows |
|---|---|
| `meeting.create` | `POST /meetings` (instant) |
| `meeting.schedule` | `POST /meetings` with `meetingType: "SCHEDULED"` (also needs `meeting.create`) |
| `meeting.read` | `GET /meetings`, `GET /meetings/{meetingId}` |
| `meeting.cancel` | `POST /meetings/{meetingId}/cancel` |
| `meeting.json.read` | `GET /meetings/{meetingId}/report` |
| `recording.read` | `GET /meetings/{meetingId}/recordings` |
| `recording.download` | `POST …/recordings/{recordingId}/download-link` |
| `webhook.manage` | `GET/PUT/DELETE /webhook`, `POST /webhook/test` |
| `meeting.plvc.unidentified` | `POST /meetings` with `plvcIdentification: "UNIDENTIFIED"` (added 13 Nov 2026; also needs `meeting.create`) |

## 2. Authentication

```
Authorization: Bearer oic_live_xxxxxxxxxxxxxxxx_xxxxxxxx…
```

`X-Api-Key: <key>` is also accepted.

- Call the API from your **server**. Never put the key in a browser or a mobile app.
- HTTPS only.
- A key never grants access to the OneInsure portal itself, and portal cookies grant nothing on the API.
- A POST without a body (download-link, webhook/test) must send `Content-Length: 0`, which normal HTTP clients do automatically. The web server rejects a POST that has no length at all with 411.

**Isolation.** Every meeting and recording created through your integration carries your Integration ID. Every request is filtered on it, so another portal's meeting or recording is always `404 NOT_FOUND`, even if you know its id.

## 3. Typical workflow

```
POST /meetings                → meetingId (OIC-…), participant join links, meetingLink, hostJoinUrl
   (share the links with your users)
webhooks: meeting.started, participant.joined/left, recording.*, meeting.completed
   (or poll GET /meetings/{meetingId})
GET  /meetings/{meetingId}/report        → completion JSON (call again until the recording is Completed)
POST /meetings/{meetingId}/recordings/{recordingId}/download-link → short-lived URL → GET it
```

### Create a meeting

```http
POST /meet/api/ext/v1/meetings
Authorization: Bearer <API key>
Content-Type: application/json
Idempotency-Key: YOUR-REF-001

{
  "category": "Customer-PLVC",
  "meetingType": "Instant",
  "meetingTitle": "Customer PLVC Meeting",
  "prarambhMainId": "123456789",
  "host": { "email": "host.employee@oneinsure.com" },
  "participants": [ { "name": "Customer Name", "email": "customer@example.com" } ],
  "durationMinutes": 30,
  "externalReference": "YOUR-REF-001"
}
```

| Field | Rules |
|---|---|
| `category` | `CUSTOMER_PLVC` (also `Customer-PLVC`, `PLVC`), `CUSTOMER_GENERAL`, `INTERNAL`, `TRAINING`, `TEAM`, or any portal category code |
| `meetingType` | `INSTANT` (starts now) or `SCHEDULED` (needs `startTime`, e.g. `2026-11-14T11:00:00+05:30`) |
| `prarambhMainId` | **Required for PLVC: digits only, 1–30 digits.** It is stored exactly as sent (leading zeros are kept), and the recording file name starts with it. It is **refused** for every other category. |
| `host` | `email` or `employeeCode` of an active OneInsure employee who has a portal login. If omitted, the integration's default host is used. For customer categories the host must be allowed to hold customer meetings. |
| `participants` | Name and e-mail each; at most 20; no duplicate e-mails. For customer meetings the **first participant is the customer**: an existing customer with that e-mail is reused, otherwise one is created. The others are guests. |
| `durationMinutes` | 5 minutes up to the configured maximum |
| `recordingPolicy` | `NONE`, `OPTIONAL` or `REQUIRED`. The category's approved recording policy always applies: PLVC is recorded automatically, with a notice and no acceptance step. |
| `audioOnly`, `waitingRoomEnabled`, `purpose`, `description`, `externalReference` | optional |
| `plvcIdentification` | Optional (13 Nov 2026). Omit it for the normal, **identified** PLVC call. Send `"UNIDENTIFIED"` only for an **instant** `CUSTOMER_PLVC` meeting **without** `prarambhMainId` and **without** `participants`. The integration needs the `meeting.plvc.unidentified` scope, otherwise you get 403 `INSUFFICIENT_SCOPE`. The meeting is recorded as normal, the recording file name has no ID prefix, and no ID is ever generated. Every meeting response and the `meeting.created` webhook return `plvcIdentification` (`IDENTIFIED`, `UNIDENTIFIED`, or `null` for other categories). |

The response is `201 Created`:

```json
{
  "success": true,
  "meetingId": "OIC-261113-AB12",
  "id": "8d6f…",
  "integrationId": "INT-1A2B3C4D5E",
  "externalReference": "YOUR-REF-001",
  "category": "CUSTOMER_PLVC",
  "meetingType": "INSTANT",
  "prarambhMainId": "123456789",
  "status": "Scheduled",
  "startTime": "2026-11-13T10:00:00+05:30",
  "endTime": "2026-11-13T10:30:00+05:30",
  "meetingLink": "https://www.oneinsure.com/meet/m/…",
  "hostJoinUrl": "https://www.oneinsure.com/meet/meetings/8d6f…/room",
  "host": { "name": "Host Name", "email": "host.employee@oneinsure.com", "employeeCode": "E1234" },
  "participants": [
    { "name": "Host Name", "type": "EMPLOYEE", "role": "HOST", "joinUrl": null },
    { "name": "Customer Name", "email": "customer@example.com", "type": "CUSTOMER", "role": "ATTENDEE", "joinUrl": "https://www.oneinsure.com/meet/join/…" }
  ]
}
```

**Links:**
- **Instant meetings** return a personal `joinUrl` per participant. They are returned **only once**, so store them.
- **Scheduled meetings** e-mail each participant a personal, expiring link, and return the shareable `meetingLink` (whoever opens it waits until the host admits them).
- The host opens `hostJoinUrl` after signing in to OneInsure Connect.

**Idempotency.**
- The same `Idempotency-Key` with the same body returns the original response (header `Idempotent-Replayed: true`). It never creates a second meeting.
- The same key with a different body returns `422 IDEMPOTENCY_KEY_REUSED`.
- While the first request is still running, a repeat returns `409 REQUEST_IN_PROGRESS`.

### Meeting completion report

`GET /meetings/{meetingId}/report` returns actual stored data only. Nothing is estimated or invented.
- `meeting`: status `Scheduled`, `Live`, `Completed`, `Cancelled`, `Expired` or `Incomplete`; `completed`; scheduled and actual start/end; `durationMinutes`; `prarambhMainId`; `externalReference`.
- `participants`: name, e-mail, type and role, plus join/leave sessions and `attendedSeconds`, as recorded by the video server. With no recorded attendance, the times are `null`.
- `recording` (the latest) and `recordings` (all), with status:
  - `NotStarted`, `ConsentPending`, `Starting`, `Recording`;
  - `Processing` (the MP4 is being built and verified);
  - `Completed`, `Failed`, `Deleted`.
- **Meeting and recording status are independent.** A `Completed` meeting can still have a `Processing` recording, so call again later or wait for the `recording.completed` webhook.
- `summary.available` is `false`: minutes-of-meeting (MOM) generation is not part of v1.

### Download a recording

`POST /meetings/{meetingId}/recordings/{recordingId}/download-link` returns `{ url, expiresAt, fileName }`.
- The URL is signed and bound to your integration.
- It is valid for 5 minutes by default and needs no API key, so you can hand it to a browser.
- It supports HTTP `Range`, for large MP4s.
- Errors:
  - `409 RECORDING_NOT_READY` (still processing);
  - `409 RECORDING_FAILED`;
  - `410 RECORDING_DELETED`;
  - `404` for anything that is not yours.
- Recordings are never public. Server paths are never returned.
- Every link issued and every download is audited.

## 4. Errors

All errors are `application/problem+json`:

```json
{ "status": 400, "code": "VALIDATION", "detail": "Please correct the highlighted fields.", "errors": { "prarambhMainId": "…" } }
```

| HTTP | `code` | When |
|---|---|---|
| 400 | `VALIDATION` | Invalid input. `errors` names each field (`prarambhMainId`, `participants[1].email`, `host`, …). |
| 401 | `UNAUTHORIZED`, `KEY_REVOKED` | Missing, unknown or revoked key |
| 403 | `INSUFFICIENT_SCOPE` | The key lacks the scope (see `requiredScope`) |
| 403 | `INTEGRATION_INACTIVE` | The integration is deactivated |
| 403 | `HOST_NOT_PERMITTED` | The host cannot hold customer meetings |
| 404 | `NOT_FOUND` | Not found **for this integration** |
| 409 | `CONFLICT` | Calendar conflict, or the meeting already started (cancel) |
| 409 | `RECORDING_NOT_READY`, `RECORDING_FAILED`, `REQUEST_IN_PROGRESS` | See above |
| 410 | `RECORDING_DELETED` | Deleted by an authorised user |
| 422 | `IDEMPOTENCY_KEY_REUSED` | Same key, different body |
| 429 | `RATE_LIMITED` | Over the integration's per-minute limit. Wait `Retry-After` (60) seconds. |

## 5. Rate limits

Each integration has its own fixed per-minute limit (default 60, set by the administrator). Other portals are never affected. Every request is logged with method, path, status, duration and IP, and the log is visible to the administrator.

## 6. Webhooks

Configure one HTTPS endpoint, either with `PUT /webhook` `{ "url": "https://…", "events": [ … ] }` or in the Integrations tab.
- The **signing secret** (`whsec_…`) is returned only when the subscription is created or the secret is rotated (`"rotateSecret": true`).
- The URL must be public HTTPS. Private, loopback and link-local addresses are refused (SSRF protection), and redirects are not followed.

| Event | When |
|---|---|
| `meeting.created` | Meeting created through the API |
| `meeting.started` | The host started the meeting |
| `participant.joined` / `participant.left` | A participant joined or left. Only `type` and an opaque `participantRef` are sent. |
| `recording.consent_requested` | Participants were asked to consent to recording |
| `recording.started` / `recording.stopped` | Recording started / stopped (processing begins) |
| `recording.completed` / `recording.failed` | MP4 ready / processing failed |
| `meeting.completed` | The meeting ended |

Each delivery is a `POST` with these headers:
- `X-OIC-Event`
- `X-OIC-Event-Id` (unique; de-duplicate on it)
- `X-OIC-Timestamp`
- `X-OIC-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, t + "." + rawBody)>`

Payload:

```json
{ "eventId": "…", "eventType": "recording.completed", "occurredAt": "2026-11-13T10:36:05+05:30", "integrationId": "INT-…", "apiVersion": "v1",
  "data": { "meetingId": "OIC-261113-AB12", "externalReference": "YOUR-REF-001", "recordingId": "…", "status": "Completed" } }
```

Delivery rules:
- Payloads carry ids and statuses only, never names or e-mails.
- Each state change is delivered **once**.
- A non-2xx answer or a timeout (10 s) is retried after 30 s, 2 min, 10 min, 30 min, 2 h, then 6 h, up to 8 attempts. After that the delivery is marked FAILED, and an administrator can retry it.
- `POST /webhook/test` sends a signed `webhook.test` event.

Verify the signature (Node.js):

```js
const crypto = require('crypto')
function verify(rawBody, header, secret) {
  const { t, v1 } = Object.fromEntries(header.split(',').map((p) => p.split('=')))
  const expected = crypto.createHmac('sha256', secret).update(t + '.' + rawBody).digest('hex')
  return Math.abs(Date.now() / 1000 - Number(t)) < 300 && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(v1))
}
```

## 7. Importing into Postman or other clients

Download the OpenAPI JSON, either from the API Documentation page (**Download OpenAPI (JSON)**) or from the URL above. Import it as an OpenAPI 3.1 file and set the collection's Bearer token to your API key.

The document is generated from the implemented endpoints. It validates with the open-source `@apidevtools/swagger-parser` 10.1.1 (OpenAPI 3.1.1, 10 paths, 22 schemas). An actual Postman import has not been tested on this server, where Postman is not installed.
