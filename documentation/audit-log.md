# Audit log

Every change, sign-in and check is recorded in the audit log, linked into a tamper-evident hash chain (see [audit-streaming.md](../ee/docs/audit-streaming.md) for verifying, exporting and streaming it). Reading it needs the permission `audit_log:read`; an organisation user reads their organisation's events only.

## In the dashboard

**Observe → Audit log** lists the events newest first, 50 to a page. The filter bar searches the summaries and narrows the list by actor, action, entity type and time range (last hour, 24 hours, 7 days, 30 days or all time); the filters are kept in the address, so a filtered view can be bookmarked or shared (`/audit-log?actor=7&entityType=proxy_host&range=7d`, `q`, `action`, `entityId`, `from`, `to` and `page` work the same way).

Expand an event to see what was recorded with it: for a configuration change the before and after of its own entity, field by field (unified or side by side, secrets masked), with links to the change in the change history and to rolling back to the version before it; for other events the data stored with them. Every event shows its hash and the previous event's hash.

Administrators at the provider level also see the state of the hash chain (the last verification, how many events were recorded since, the anchor and the newest hash) with **Verify now**, and the streaming destinations with their lag; see [audit-streaming.md](../ee/docs/audit-streaming.md). Organisation users see their own organisation's events only.

## Filters

`GET /api/v1/audit-log` filters on the server; every filter is optional and they combine:

| Parameter | Matches |
| --- | --- |
| `search` | Text in the summary, the action or the entity type, matched literally |
| `actor` | A user id, or `system` for events no user recorded |
| `action` | An exact action, such as `update` or `alert_rule_updated` |
| `entityType`, `entityId` | An exact entity, such as `proxy_host` and `12` |
| `from`, `to` | ISO 8601 dates or date-times, inclusive; a bare `to` date includes that whole day |
| `page`, `per_page` | Pages of up to 200 events, newest first |

Each event names who acted (as the user is now), its hash and the previous hash, and for a configuration change the configuration history versions around it (`configChange`). `GET /api/v1/audit-log/facets` lists the actors, actions and entity types that occur, for filter menus.

## Before and after

With [configuration history](../ee/docs/config-history.md) recording, an event about a configuration entity (a proxy or L4 host, an access list, a certificate, a group, a settings group, an import or a restore) stores the version before the change and the version its apply recorded. `GET /api/v1/audit-log/{id}` returns the event with its data and the before/after diff of its own entity, field by field, with secrets masked. Events recorded before this existed, or while history was off, have no diff; once retention deletes one of the two versions, the diff says it is no longer available.

```bash
curl "https://dash.example.com/api/v1/audit-log?entityType=proxy_host&entityId=12&from=2026-10-01" -H "Authorization: Bearer $TOKEN"
curl "https://dash.example.com/api/v1/audit-log/24106" -H "Authorization: Bearer $TOKEN"
```
