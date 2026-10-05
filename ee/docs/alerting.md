# Alerting

Notifications when something needs attention: certificates about to expire or failing renewal, failing upstreams, WAF block spikes, 5xx error rates, failed instance syncs, failed Caddy config applies, an expiring license, failing scheduled backups, drifted fleet instances and failed fleet rollouts. Configure it on **Alerts** in the dashboard or through `/api/v1/alert-*`.

Feature id: `alerting` (Homelab edition and up). Code: `ee/alerting/`.

## How it works

- **Channels** say where notifications go: e-mail (SMTP), Slack, Microsoft Teams, a generic webhook, PagerDuty or ntfy.
- **Rules** say what to watch, which channels to notify, the cooldown and whether to send a notice when the condition clears. Rules that watch hosts can be limited to chosen proxy hosts (`scope`), and most rules can wait until a condition has held for a while before firing (`forMinutes`).
- An evaluator runs every 60 seconds on the node where the rules are configured (started from `src/instrumentation.ts`, never in tests). For each rule it lists the *subjects* that currently match (one per expiring certificate, failing upstream, failing instance, ...):
  - A subject that starts matching **fires**: one notification, unless a firing notification for the same rule and subject went out less than `cooldownMinutes` ago. The transition is recorded in the history either way.
  - A firing subject that stops matching **resolves**. The resolve notice goes to every channel when `notifyOnResolve` is set, and always to PagerDuty channels so the incident closes, but only if the firing notification was sent.
  - While a subject keeps firing, nothing is sent again.
  - With `forMinutes` set, a subject that starts matching is first **pending** and fires only once it has matched on every evaluation for that many minutes. One that stops matching while pending is forgotten, with no event and no notification. The rule lists its pending subjects (`pending`).
  - When a rule cannot be evaluated (Caddy admin API unreachable, ClickHouse not configured or failing) nothing changes: firing alerts are not resolved by mistake. When it can tell about some subjects only (Caddy's HTTPS port unreachable while imported certificates can still be read), the others keep their state.
  - At most 20 new subjects per rule are handled per run; the rest follow on the next run, so a burst cannot flood a channel.
- History (`alert_events`) is kept for 90 days. Disabling or deleting a rule forgets what was firing without sending resolve notices (so a PagerDuty incident it opened stays open until resolved in PagerDuty); a deleted rule's history is kept.
- Alerts are not synced to slave instances. A slave keeps no rules unless someone configures them on it directly.

## The Alerts page

**Alerts** (Observe group, `/alerts`) has four tabs:

- **Firing**: every subject firing now, with its severity, since when, which channels were told and what happens when it clears, and the subjects waiting out a "for" duration. Under it, the alerts of the last 7 days: select one for what happened (with the AI explanation, labelled as such), who was told when it fired and when it resolved, and links to look closer (the host, certificate or security events it is about, and the audit log around that time). **Full history** (`/alerts?tab=history`, `&page=` for later pages) pages through the 90 days kept, 25 alerts at a time.
- **Rules**: each rule's condition, scope, "for" duration, usual severity, channels (a channel whose last delivery failed is marked), when it last fired and whether it is on, searchable by name, condition, scope and channel and paged 25 at a time. **New rule** opens the editor: the condition and its parameters, the hosts it watches (all hosts or chosen ones, for the rule types that accept a scope), the "for" duration, the channels, the cooldown, the resolve notice and the AI explanation.
- **Channels**: where each channel delivers (the host only, never a credential), how many rules use it, its last delivery and **Send test**, searchable by name, type and destination and paged 25 at a time. A channel whose last delivery failed is also shown in a banner above the table.
- **AI**: the AI provider for explanations and the daily security digest (permission `ai:read`).

Without `alerts:write` the page is read-only. Without a license with Alerting, paid channels and rules are shown read-only and can still be turned off and deleted.

## Rule types

| Type | Parameters | What is evaluated |
| --- | --- | --- |
| `cert_expiring` | `days` (1-365, default 14), `includeClientCertificates` (default true), `includeManagedCertificates` (default true) | Certificates whose PEM the dashboard stores: imported certificates, CA certificates, and issued client certificates that are not revoked; and the certificates Caddy obtains itself (ACME, or its internal CA) for enabled proxy hosts, see below. Already expired ones keep firing until replaced. |
| `upstream_down` | `minFails` (default 1) | Caddy's `GET /reverse_proxy/upstreams`. See the note below. |
| `waf_spike` | `threshold` (default 100), `windowMinutes` (1-1440, default 15) | Requests blocked by the WAF in ClickHouse over the window. Skipped when ClickHouse analytics is not configured. |
| `error_rate` | `thresholdPercent` (0.1-100, one decimal, default 5), `windowMinutes` (1-1440, default 5), `minRequests` (default 20), `perHost` (default true) | The share of 5xx responses in ClickHouse's traffic over the window: one alert per proxy host (`perHost`), or one for the hosts in scope together. Counts only when there were at least `minRequests` requests; fires when the share is above the threshold. Skipped when ClickHouse analytics is not configured or cannot be queried. |
| `instance_sync_failed` | none | Enabled instances whose last sync failed (`lastSyncError`), in master mode. |
| `caddy_apply_failed` | none | The last attempt to push the configuration to Caddy failed; resolves after the next successful apply. |
| `license_expiring` | `days` (default 30) | The installed license expires within the window (also fires during the grace period and after expiry). |
| `backup_failed` | `minFailures` (1-100, default 1) | Enabled scheduled-backup destinations whose backups failed that many times in a row (see [scheduled-backups.md](scheduled-backups.md)); resolves after the next successful backup. Failed backups are retried after 5 minutes, then with growing delays. |
| `approval_pending` | none | Each change request waiting for approval (see [change-approvals.md](change-approvals.md)), so approvers hear about it once; resolves when it is approved, rejected, cancelled or expires. |
| `access_review_started` | none | An access review campaign is open (started by hand or by a schedule, see [access-reviews.md](access-reviews.md)); severity info; resolves when it is completed or cancelled. |
| `access_review_overdue` | none | An open access review is past its due date with items nobody confirmed yet; resolves when it is completed, cancelled or every item is confirmed. |
| `fleet_drift` | none | Enabled instances whose last drift check found them drifted (see [fleet.md](fleet.md)), in master mode; resolves after a re-sync or a check that finds them in sync. |
| `fleet_rollout_failed` | none | Fleet environments whose latest rollout failed (see [fleet.md](fleet.md)), in master mode; resolves when a later rollout starts there. |

### Scope and "for" duration

`scope` is `{"type":"all"}` (the default) or `{"type":"hosts","proxyHostIds":[...]}` (1 to 200 existing proxy hosts). Only these rule types accept a host list:

- `cert_expiring`: the imported certificates those hosts use and the certificates Caddy manages for them. CA and client certificates belong to no host, so only a rule without a host list covers them.
- `upstream_down`: the upstreams of those hosts.
- `waf_spike`: requests blocked on their domains.
- `error_rate`: their traffic.

Every other type answers 400 for a host list. Each rule's view has a `scopeLabel` that says what it watches in words ("Each proxy host", "Upstreams of 3 proxy hosts", "This node"). It also has `lastFiredAt`: when the rule last fired, from its newest firing event in the 90-day history (null when it has not).

`forMinutes` (0 to 1440, default 0: fire at once) is accepted by `cert_expiring`, `upstream_down`, `waf_spike`, `error_rate`, `instance_sync_failed`, `caddy_apply_failed`, `backup_failed` and `fleet_drift`. Rules about one-off events (a change waiting for approval, a review that started or is overdue, a failed rollout, an expiring license) fire at once and answer 400 for any other value.

### Certificates Caddy manages

Caddy keeps the certificates it obtains in its own storage, which the dashboard cannot read; it reads the certificate Caddy presents for each domain with a TLS handshake instead (`src/lib/managed-certificates.ts`), the same reading the certificates page shows. How that works, the cache and the `CADDY_TLS_ADDRESS` setting are described in [Where the expiry comes from](../../documentation/certificates.md#where-the-expiry-comes-from).

- Checked names: the domains of enabled proxy hosts without an imported certificate, or with a "managed" certificate entry (DNS-01). A wildcard domain is checked as `tls-check.<domain>`; IP addresses are skipped.
- Caddy renews a certificate when a third of its lifetime is left. A certificate past that point plus one day is reported as **renewal overdue**: the renewal is failing. A name Caddy has no certificate for (Caddy answers with a TLS "internal error" alert) is reported as **missing**, a certificate that does not cover the name as a **mismatch**. Any other TLS error (for example a host that demands a client certificate) is not taken as a missing certificate.
- The rule fires for managed certificates that expire within `days`, whose renewal is overdue, that are missing or that do not cover the name. A missing certificate of a host saved in the last 15 minutes is left alone while Caddy obtains it. When Caddy's HTTPS port cannot be reached, alerts about managed certificates keep their state.
- `GET /api/v1/certificates/managed` (permission `certificates:read`, limited to the caller's tag scope and organisation) lists them; `?refresh=true` checks names older than a minute again.

What is not covered, and why:

- **L4 (TCP/UDP) hosts** that terminate TLS are not checked.
- **Upstream health.** In Caddy 2.11 the admin API reports, per HTTP reverse-proxy upstream, only its address, requests in flight and `fails`: the failures counted by *passive* health checks within their `fail_duration`. Caddy counts nothing unless the host has passive health checks with a non-zero fail duration (load balancing settings of the proxy host). The result of *active* health checks is not exposed, and caddy-l4 (TCP/UDP) upstreams are not in this pool. `upstream_down` therefore means "recent failed requests", not "marked unhealthy by an active check".
- **Environment-configured slaves** (`INSTANCE_SLAVES`) do not store their last sync result; only instances added in the dashboard are watched by `instance_sync_failed`.
- **`caddy_apply_failed`** watches the last apply attempt made by this process. A brief failure that a later apply fixes before the next evaluation (within a minute) is not reported. If the apply at startup fails (for example because Caddy was not up yet), the alert fires and stays until the next successful apply.

## Channels

| Type | Settings | Secrets (encrypted, never returned) |
| --- | --- | --- |
| `email` | `host`, `port` (default 587, or 465 with `secure`), `secure` (implicit TLS; otherwise STARTTLS when offered), `user`, `from`, `to` (1-20 addresses) | `password` |
| `slack` | | `webhookUrl` (incoming webhook, https) |
| `teams` | | `webhookUrl` (Workflows "post to a channel when a webhook request is received" URL, or a legacy incoming webhook; https). Sent as an Adaptive Card. |
| `webhook` | | `url` (http or https), optional `hmacSecret` |
| `pagerduty` | `region` (`us` or `eu`) | `routingKey` (Events API v2 integration key). Triggers and resolves with a stable `dedup_key` per rule and subject. |
| `ntfy` | `serverUrl` (default `https://ntfy.sh`), `topic` | optional `token` |

Credentials, including webhook URLs that embed a token, are stored encrypted with `SESSION_SECRET` and re-encrypted by the startup rotation pass like every other stored secret. The API and the dashboard only show `has*` flags and, for URLs, the scheme and host. When updating a channel, an omitted or empty secret keeps the stored one and `null` removes an optional one. Changing the SMTP host or the ntfy server requires entering the password or token again, so a stored credential is never sent to a destination it was not entered for.

Delivery uses a 10 s timeout and does not follow redirects. Errors are reduced to fixed messages (HTTP status, connection error code, SMTP error class); URLs, response bodies and exception messages are never stored or shown. The last delivery result is shown per channel; each history entry lists the result per channel.

**Send test** posts a test notification (for PagerDuty it opens and immediately resolves an incident).

### Webhook payload

```json
{
  "version": 1,
  "source": "ingressi",
  "status": "firing",
  "severity": "critical",
  "rule": { "id": 3, "name": "Upstreams", "type": "upstream_down" },
  "subject": "upstream:10.0.0.5:8080",
  "eventId": 42,
  "title": "Upstream 10.0.0.5:8080 is failing (3 recent failures)",
  "message": "Caddy counted 3 recent failed requests to upstream 10.0.0.5:8080, used by \"App\". ...",
  "facts": { "upstream": "10.0.0.5:8080", "recentFailures": 3, "proxyHosts": ["App"] },
  "explanation": { "label": "AI-generated explanation", "text": "..." },
  "at": "2026-10-02T10:00:00.000Z"
}
```

`status` is `firing`, `resolved` or `test`; `explanation` is null unless the rule asks for one and the model answered. With an HMAC secret, requests carry `X-Ingressi-Timestamp` (Unix seconds) and `X-Ingressi-Signature: sha256=<hex HMAC-SHA256(secret, timestamp + "." + raw body)>`. Verify the signature over the raw body and reject old timestamps.

## AI explanations

A rule with `explain: true` asks the AI provider configured on the AI tab for a short plain-language explanation of each firing alert. See [ai-analyst.md](ai-analyst.md).

## REST API

All endpoints are admin-only (API token or session) and audited; see `/api/v1/openapi.json` (tags *Alerting* and *AI*).

| Method and path | |
| --- | --- |
| `GET /api/v1/alert-channels`, `POST /api/v1/alert-channels` | List, create |
| `GET`, `PUT`, `DELETE /api/v1/alert-channels/{id}` | Read, update (partial), delete (409 while a rule uses it) |
| `POST /api/v1/alert-channels/{id}/test` | Send a test notification: `{"ok": true, "error": null}` |
| `GET /api/v1/alert-rules`, `POST /api/v1/alert-rules` | List (with the subjects currently firing), create |
| `GET`, `PUT`, `DELETE /api/v1/alert-rules/{id}` | Read, update (partial; params are merged), delete |
| `GET /api/v1/alert-events?page=&per_page=&rule_id=` | History, newest first. A firing event carries `resolvedAt`, when that episode ended (null while it fires). |
| `GET /api/v1/alert-events/firing` | Every subject firing now, most severe first, with the event that started it and the channels told |

```bash
curl -X POST https://ingressi.example.com/api/v1/alert-channels \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Ops","type":"email","config":{"host":"smtp.example.com","user":"alerts","password":"…","from":"alerts@example.com","to":["ops@example.com"]}}'

curl -X POST https://ingressi.example.com/api/v1/alert-rules \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Certificates","type":"cert_expiring","params":{"days":21},"channelIds":[1]}'
```

The type of a channel or rule cannot be changed after creation.

## Licensing

A license only controls **setting up and changing** alerting; nothing that runs is ever checked:

- **Community (no license):** e-mail channels, and `cert_expiring` rules that only notify e-mail channels, can be created and changed. Their test notifications work too.
- **With `alerting`:** every other channel type and rule type (`error_rate` included), and certificate rules that notify a non-e-mail channel. Scopes and `forMinutes` follow the rule's own license rule.
- **With `ai_analyst`:** turning `explain` on for a rule, and setting up the AI provider.
- **Winding down never needs a license:** deleting any channel or rule, an update whose body only disables (`{"enabled": false}` for channels; `{"enabled": false}` and/or `{"explain": false}` for rules) and removing the AI provider always work, so an install whose license lapsed can switch everything off.
- Without the license, paid channels and rules stay visible (read-only), keep being evaluated and keep delivering. Changing them (renaming, editing, re-enabling, sending a test) answers 403 until a license is installed again. An expired license keeps everything editable for its 30-day grace period.
- Reading (`GET`) never needs a license.

## Data

Tables (migration `drizzle/0028_alerting.sql`; `scope`, `forMinutes` and `pendingSince` from `0046_governance.sql`): `alert_channels`, `alert_rules`, `alert_rule_states` (per rule and subject: firing, pending or not, last notification, whether the firing notice was sent) and `alert_events` (history; no foreign key, survives rule deletion). Who created or changed what is in the audit log (`alert_channel_*`, `alert_rule_*`).
