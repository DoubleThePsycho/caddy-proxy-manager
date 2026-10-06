# Audit streaming, export, retention and tamper evidence

Feature id `audit_streaming`, included in the **Business** edition and above. Code: `ee/audit/` (Elastic License 2.0) and the free hash chain in `src/lib/audit-chain.ts` (MIT).

## What it does

- **Hash chain (free, always on).** Every audit event is stored with `hash = sha256(prevHash + canonicalJson(event))`, where `prevHash` is the hash of the event before it. Changing, removing or inserting an event in the middle of the log breaks the chain. Events recorded before the upgrade keep empty hashes; the chain starts at the first event recorded after it.
- **Verification.** Recomputes the chain and reports the first event that does not match.
- **Export.** Downloads the audit log as CSV or JSON, optionally for a date range. Exports carry the chain fields, so a copy can be checked offline.
- **Streaming.** Sends every audit event to one or more sinks (a webhook, syslog or Splunk HEC) a few seconds after it is recorded.
- **Retention.** Deletes events older than a number of days, once a day.

## Setup

In the dashboard, open **Audit log**:

- **Export CSV or JSON** downloads the log. The banner at the top shows the last verification of the hash chain (when, how many events, the anchor and the head hash, and how many events were recorded since); **Verify now** checks it again.
- The **Streaming** cards under the events show each sink's status, the newest event it received, how many events wait for it and its lag (how long ago the oldest waiting event was recorded).
- **Streaming and retention** (`/audit-log/streaming`) lists the sinks with their status, last delivery, waiting events, lag and last error. Add, edit, delete or send a test event to a sink there, and set the retention.

A new sink receives events recorded from the moment it is created. Turn on **Send events already in the log** (`"backfill": true` in the API) to deliver everything that is still in the log first.

### Sink types

| Type | Delivery |
| --- | --- |
| `webhook` | `POST <url>` with body `{"events": [...]}` (up to 100 events). Headers: `X-Ingressi-Timestamp` (Unix seconds) and `X-Ingressi-Signature: sha256=<hex HMAC-SHA256(secret, timestamp + "." + body)>`. The signing secret is required (at least 16 characters). Any 2xx response is success; redirects are not followed. |
| `splunk_hec` | `POST <url>/services/collector/event` with `Authorization: Splunk <token>`. The body holds one JSON object per line: `{"time", "host", "source": "ingressi", "sourcetype": "ingressi:audit", "index"?, "event": {...}}`. Give the base URL (for example `https://splunk.example.com:8088`); a URL that already ends in `/services/collector` or `/services/collector/event` is used as is. |
| `syslog` | RFC 5424 messages over UDP (one datagram per event), TCP (RFC 6587 octet counting) or TLS (RFC 5425, TLS 1.2+, certificate and hostname verified). Default ports 514 (UDP, TCP) and 6514 (TLS), default facility 13 (log audit), severity notice. Structured data `[ingressi@32473 id=… action=… entityType=… entityId=… userId=… hash=…]` and the whole event as ASCII-only JSON in MSG. For a private CA, paste its PEM into the sink (TLS only). UDP messages over 8 KiB have `data` replaced by a truncation note. 32473 is the documentation enterprise number (RFC 5612). |

Webhook and Splunk URLs must be `http` or `https` and must not contain credentials (use the secret field) or a fragment. Syslog hosts must be a hostname or an IP address, ports 1 to 65535. HTTPS uses the system trust store; add a private CA with `NODE_EXTRA_CA_CERTS`.

Every delivered event has this shape:

```json
{
  "id": 1234,
  "createdAt": "2026-10-02T10:00:00.000Z",
  "userId": 7,
  "userEmail": "admin@example.com",
  "userName": "Admin",
  "action": "proxy_host_created",
  "entityType": "proxy_host",
  "entityId": 42,
  "summary": "Created proxy host app.example.com",
  "data": "{\"domains\":[\"app.example.com\"]}",
  "prevHash": "…",
  "hash": "…",
  "source": "ingressi",
  "host": "web-1"
}
```

`data` is the stored text exactly as it was hashed (usually JSON). `userEmail` and `userName` are the user's current details at delivery time; they are null once the user is deleted. Test events have `"id": 0` and `"test": true`.

### Delivery guarantees

A background job checks enabled sinks every 10 seconds and delivers events with an id above the sink's cursor, oldest first, in batches of up to 100. The cursor advances only after the receiver accepted a batch, so delivery is **at least once**: after a failure or a restart a batch can arrive twice. Deduplicate on `id` (or `hash`). A failing sink is retried with exponential backoff (10 s, 20 s, 40 s, … up to 30 minutes); editing or re-enabling it retries at once. Errors shown in the dashboard name a status code or an error code only, never a response body.

Retention also deletes events that a failing sink has not received yet.

### Retention

`0` (the default) keeps events forever. Otherwise a daily job (first run a minute after start-up) deletes the oldest events older than the setting. It only deletes a contiguous run of the oldest events and always keeps the newest one, so new events keep linking to the chain. Each run that deletes events records an `audit_log_pruned` event.

## Hash chain and verification

```
canonicalJson = JSON.stringify({ v: 1, createdAt, actor: actorDigest, action, entityType, entityId, summary, data })
hash          = sha256_hex((prevHash ?? "") + canonicalJson)
actorDigest   = userId == null ? null : sha256_hex("audit-actor:" + userId)
```

The hash covers `actorDigest` rather than `userId`: deleting a user clears `userId` on that user's events, which must not break the chain. Verification still flags an event whose `userId` was changed to another user.

Verification starts at the **oldest remaining chained event** and trusts its `prevHash` as the anchor (retention deletes older events). It reports:

- `ok`, `checked`, `firstMismatchId` and `reason`;
- `anchoredAt`, `anchorId`, `anchorHash`: where verification started;
- `headId`, `headHash`: the newest event;
- `unchainedEvents`: events from before the chain existed.

What it can and cannot show:

- It detects changed, removed and inserted events anywhere after the anchor.
- Deleting the **newest** events, or the **oldest** ones, leaves a valid shorter chain. Compare `headHash` and `anchorHash` with a streamed or exported copy to rule that out; that external copy is what makes the log tamper-evident against someone who can write to the database.
- The hash is not keyed. Someone who can rewrite the database can recompute the whole chain, and only an external copy reveals that.

To verify an export offline, recompute `hash` for every event with the formula above, using the exported `prevHash`, `actorDigest`, `createdAt`, `action`, `entityType`, `entityId`, `summary` and `data`, and check that each `prevHash` equals the previous event's `hash`.

## API

All endpoints need an administrator (API token or session).

| Endpoint | License |
| --- | --- |
| `GET /api/v1/audit-log/export?format=csv\|json&from=&to=` | required |
| `GET /api/v1/audit-log/verify` | required |
| `GET /api/v1/audit-log/retention` | not required |
| `PUT /api/v1/audit-log/retention` `{"days": 90}` | required, except `{"days": 0}` |
| `GET /api/v1/audit-sinks` | not required |
| `POST /api/v1/audit-sinks` | required |
| `GET /api/v1/audit-sinks/{id}` | not required |
| `PUT /api/v1/audit-sinks/{id}` | required, except `{"enabled": false}` alone |
| `DELETE /api/v1/audit-sinks/{id}` | not required |
| `POST /api/v1/audit-sinks/{id}/test` | required |

`from` and `to` take an ISO 8601 date or date-time; a bare date as `to` includes the whole day. CSV cells starting with `=`, `+`, `-`, `@`, a tab or a carriage return get a leading apostrophe so spreadsheets do not run them as formulas.

Create a sink:

```bash
curl -X POST https://ingressi.example.com/api/v1/audit-sinks \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"SIEM","type":"syslog","config":{"host":"siem.example.com","protocol":"tls"}}'

curl -X POST https://ingressi.example.com/api/v1/audit-sinks \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Splunk","type":"splunk_hec","config":{"url":"https://splunk.example.com:8088","index":"audit"},"secret":"<HEC token>"}'
```

A sink as returned by the API carries `lastDeliveredId` (the newest event it accepted), `pendingEvents` (events recorded after it) and `oldestPendingAt` (when the oldest of those was recorded, null when nothing waits): the sink's lag is the time since `oldestPendingAt`.

`PUT` changes only the fields it is given; `config` is merged into the stored config; leave `secret` out to keep it. The type of a sink cannot be changed. Secrets (webhook signing secret, HEC token) are stored encrypted with `SESSION_SECRET`, re-encrypted on a secret rotation, and never returned: responses carry `hasSecret` instead.

Every change is recorded in the audit log: `audit_sink_created`, `audit_sink_updated`, `audit_sink_deleted`, `audit_sink_tested`, `audit_retention_updated`, `audit_log_exported` and `audit_log_verified`. Secrets are never part of these records.

The full schemas are in the OpenAPI document (`/api/v1/openapi.json`, tag *Audit Streaming*).

## Licensing behaviour

- Creating, changing, enabling and testing sinks, setting a retention period, exporting and verifying need an active license that includes `audit_streaming` (or one in its 30-day grace period). Without one these return `403`, and the dashboard shows the configuration read-only with a link to **License**.
- Winding the feature down never needs a license, so an install whose license lapsed can always turn it off: **deleting** a sink, **disabling** one (a `PUT` whose body only sets `"enabled": false`; repeating the sink's current `name` or `type` is allowed, any other field makes it a change that needs a license) and setting the retention back to **0** (keep forever). In the dashboard the sink's on/off switch, **Delete** and **Keep events forever** stay available without a license. These actions are recorded in the audit log like any other.
- Listing sinks and reading the retention never need a license.
- Sinks and retention that are already set up **keep running** with an expired, removed or invalid key: the delivery and retention jobs never check the license.
- The hash chain is free and is written for every event on every edition.

## Multi-node installs

Sinks and the retention setting are **not synced** to slave instances. Each node has its own audit log, hash chain, sinks and retention; configure streaming on every node whose dashboard people use (normally the master).
