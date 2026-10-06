# Overview

The overview is the first page after signing in. It shows what needs attention, the traffic of the last hour, 24 hours or 7 days, the busiest hosts, the nodes and the latest changes. Every section is shown only to people whose role may read it; the others do not see it at all.

## Sections

| Section | Shown with | What it shows |
| --- | --- | --- |
| Needs attention | every signed-in user | What needs attention, most severe first, with the pages that deal with it ([needs-attention.md](needs-attention.md)). Each source answers only for what the reader may see. |
| Headline figures | `analytics:read` | Requests, mitigated requests and their share, the 5xx error rate with the host that had the most, and bandwidth. Each has a trend line and the change from the period before, when the retention window still holds it. |
| Traffic | `analytics:read` | Served and mitigated requests over the range. The moment with the most mitigated requests is marked and leads to the security events of that moment (`waf:read`). |
| Busiest hosts | `analytics:read` | The six proxy hosts with the most requests, within the role's tag scope: a status dot, a bar against the busiest one, requests, the 5xx rate, mitigated requests and, with `certificates:read`, the days left on the certificate. A 5xx burst of the last 24 hours shows next to the name. Names link to the host for readers of proxy hosts. |
| Nodes | `fleet:read` or `instances:read` | This server and, on a master, its replicas: whether they are in sync, when they last synced or checked in, and the release they run. A replica on another release is marked. |
| Recent changes | `audit_log:read` | The latest audit events. **Roll back** opens the configuration history at the version from before a change, when the history still holds it and the reader may restore it (`config_history:restore`, with a license that includes configuration history, not on a replica). |

The time range is part of the address (`/?range=1h`, `/?range=7d`; 24 hours without one). Dates and times follow your preferences ([profile.md](profile.md)).

A host's status dot is grey when the host is disabled; red when its certificate expired or expires within a week, when it is answering with server errors right now, or when 5% or more of its requests got a 5xx (at least ten of them); amber after a 5xx burst, at 1% or more (again at least ten), or when the certificate expires within two weeks; green otherwise.

When analytics are off the figures are replaced by how to turn them on, and when ClickHouse does not answer the page says so; the rest of the overview stays up to date. Each section has a few seconds to answer and is left empty rather than holding up the page.

## First run

While the [setup checklist](setup-checklist.md) is neither complete nor hidden, people who may read the settings see it in place of the overview: the five steps with what to do for each, the usage ping question ([usage-ping.md](usage-ping.md)), and the traffic and busiest hosts, empty until there is something to show. Items that need attention still show above the checklist.

With `settings:write`, **Mark as done** marks a step done (for example one that does not apply) and **Hide the checklist** hides it. The overview takes over once every step is done or the checklist is hidden.

## On a phone

The sections stack in one column: the date and range, what needs attention (each item opens its first page), the headline figures two by two, the traffic chart, then the hosts, nodes and changes. The page title is in the top bar and new hosts are added from the Hosts tab.

## REST API

The overview reads the same data the REST API returns: `GET /api/v1/overview/attention`, `GET /api/v1/analytics/query` and `/api/v1/analytics/hosts`, `GET /api/v1/certificates/overview`, `GET /api/v1/audit-log`, `GET /api/v1/fleet` and `GET /api/v1/setup-checklist`.
