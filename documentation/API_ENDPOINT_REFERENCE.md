# OneInsure Connect — External API Endpoint Reference (v1)

**Audience:** developers integrating other portals.

- Base URL: `https://www.oneinsure.com/meet/api/ext/v1`
- Authentication: `Authorization: Bearer <API key>` on everything except the media download (a signed token) and the OpenAPI document.
- This list matches the generated OpenAPI document ([OPENAPI_SPECIFICATION/oneinsure-connect-ext-v1.openapi.json](OPENAPI_SPECIFICATION/oneinsure-connect-ext-v1.openapi.json)).
- Workflow, field rules, errors and webhooks are covered in the [API_INTEGRATION_GUIDE.md](API_INTEGRATION_GUIDE.md).

| Method | Path | Scope | Success | Errors (besides 401/403/429) |
|---|---|---|---|---|
| GET | `/me` | (any valid key) | 200 `ExtMe`: integrationId, name, scopes, rateLimitPerMinute, apiVersion | — |
| POST | `/meetings` | `meeting.create` (+ `meeting.schedule` for SCHEDULED) | 201 `ExtMeeting` | 400 VALIDATION / IDEMPOTENCY_KEY_INVALID, 403 HOST_NOT_PERMITTED, 409 CONFLICT / REQUEST_IN_PROGRESS / IDEMPOTENCY_KEY_USED, 422 IDEMPOTENCY_KEY_REUSED |
| GET | `/meetings?externalReference=&status=&page=&pageSize=` | `meeting.read` | 200 `ExtMeetingList` (newest first; pageSize ≤ 200) | — |
| GET | `/meetings/{meetingId}` | `meeting.read` | 200 `ExtMeeting` (`meetingId` = meeting code or id) | 404 |
| POST | `/meetings/{meetingId}/cancel` `{ "reason": "…" }` | `meeting.cancel` | 204; participants of scheduled meetings are notified | 400, 404, 409 (already started or ended) |
| GET | `/meetings/{meetingId}/report` | `meeting.json.read` | 200 `ExtMeetingReport` (meeting, host, participants with sessions, recording, recordings, summary) | 404 |
| GET | `/meetings/{meetingId}/recordings` | `recording.read` | 200 `ExtRecordingList` | 404 |
| POST | `/meetings/{meetingId}/recordings/{recordingId}/download-link` | `recording.download` | 200 `ExtDownloadLink` `{ url, expiresAt, fileName }` | 404, 409 RECORDING_NOT_READY / RECORDING_FAILED, 410 RECORDING_DELETED |
| GET | `/recordings/media/{token}` | signed token only | 200/206 `video/mp4` (HTTP Range) | 403 invalid/expired, 404, 410 |
| GET | `/webhook` | `webhook.manage` | 200 `ExtWebhook` (secret never included) | 404 |
| PUT | `/webhook` `{ url, events[], active?, rotateSecret? }` | `webhook.manage` | 200 `ExtWebhook` (`secret` only on creation or rotation) | 400 (URL not public HTTPS, unknown event) |
| DELETE | `/webhook` | `webhook.manage` | 204 (deliveries stop) | — |
| POST | `/webhook/test` | `webhook.manage` | 200 `{ eventId, status: "Queued" }` | 404 (no active webhook) |
| GET | `/api/ext/openapi/ext-v1.json` (outside `/v1`) | none | OpenAPI 3.1 document | — |

## Status values

| Meeting `status` | Recording `status` |
|---|---|
| Draft, Scheduled, Live, Completed, Cancelled, Expired, Incomplete | NotStarted, ConsentPending, Starting, Recording, Processing, Completed, Failed, Deleted |

## Not exposed

Portal and administration APIs (`/api/v1/…`) are **not** part of this API and are not in the OpenAPI document. That includes integration management itself, which is available only to signed-in administrators under Organisation → System → API Documentation.
