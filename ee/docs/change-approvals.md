# Change approvals

Code: `ee/approvals/` (Elastic License 2.0); the guards it adds to the host models and to configuration replacement live in `src/lib/models/proxy-hosts.ts`, `src/lib/models/l4-proxy-hosts.ts` and `src/lib/config-replace.ts`.

Change approvals add segregation of duties to the hosts that matter: a change to a protected proxy host or L4 proxy host is not applied when it is made. It is stored as a **change request** and applied only after other people approve it (four-eyes), and only inside a **change window** if the policy has one. An administrator-level **emergency change** can skip both, with a mandatory reason, and is flagged in the audit log. This covers the change-management and segregation-of-duties controls auditors ask for under DORA (ICT change management) and NIS2.

Configure it on the **Approvals** page or through `/api/v1/approval-policies` and `/api/v1/change-requests`. The page lists the open requests oldest first and the decided ones newest first, 25 to a page each (`?queue=` and `?tab=decided&page=`).

## Approval policies

A policy says which changes need approval:

| Field | Notes |
| --- | --- |
| `name` | Up to 100 characters, unique. |
| `description` | Optional, up to 500 characters. |
| `enabled` | A disabled policy protects nothing. |
| `targetTypes` | `proxy_host`, `l4_proxy_host` (default both). |
| `operations` | `create`, `update`, `delete`, `enable`, `disable` (default all). `update` is any change of a host's settings, including its forward-auth access and mTLS access rules; `enable`/`disable` is turning it on or off. |
| `hostTags` | Hosts carrying one of these [host tags](../../documentation/host-tags.md); empty means every host. |
| `requiredApprovals` | 1 to 10 distinct approvers (default 1). The requester never counts. |
| `allowEmergency` | Whether an emergency change may skip this policy (default true). |
| `timeZone` | IANA time zone the windows are read in (default `UTC`). |
| `windows` | When approved changes may be applied: `[{ "days": ["monday", ...], "start": "HH:MM", "end": "HH:MM" }]`, at most 14. Empty means any time. |
| `requestTtlHours` | Hours a request may wait for its approvals before it expires, 1 to 720 (default 72). |

A policy covers a change when it is enabled, names the host type and one of the operations the change performs, and the host carries one of its tags **before or after** the change. So adding a protected tag to a host, or taking it away, needs approval too. A form edit that also turns the host off is both `update` and `disable`.

When several policies cover a change, the strictest wins: the most approvals, every window (the change waits until all of them are open together), the shortest expiry, and no emergency change if any of them forbids it. Policies are re-read when a request is approved and applied: if a policy asks for more approvals by then, the request needs them; if it was disabled or deleted, the request keeps the approvals it was made with.

## What happens to a change

1. Someone with the host permission (`proxy_hosts:write` or `l4_proxy_hosts:write`) changes a protected host: in the dashboard, or with `POST`, `PUT` or `DELETE` on `/api/v1/proxy-hosts`, `/api/v1/l4-proxy-hosts`, `/api/v1/proxy-hosts/{id}/forward-auth-access` or `/api/v1/proxy-hosts/{id}/mtls-access-rules`. Their usual checks run first (permission, tag scope, references, raw Caddy JSON, port 2019).
2. Instead of applying it, a change request is stored with the requester, the target, the operation, the validated input, the host as it is now (and its fingerprint), the covering policies, the approvals needed and the expiry. The REST API answers **202** with the request; the dashboard says so before saving (the proxy host editor's review shows which policy covers the change, the approvals it needs, the change window and the impact; the L4 host dialogs show the policy) and after. Administrators are no exception.
3. People holding `approvals:approve` approve or reject it, with a comment (required to reject). **Nobody approves their own request**: user ids are compared, so a second API token of the same user does not help. Each approver counts once. Anyone who can see the request may comment; the requester (or an administrator) may cancel it.
4. With enough approvals the request is **approved**. If every covering policy's window is open, it is applied at once. Otherwise it waits: a job checks every minute and applies it when the windows open, or an approver applies it with **Apply now** while they are open.
5. Applying re-checks everything and calls the same model functions as a direct change (audited as the requester's change, applied to Caddy, synced to slaves):
   - the host must be exactly as it was when the request was made (its fingerprint covers the host, its forward-auth access and its mTLS access rules), otherwise the request **fails** with "The host changed after this request was made; submit the change again";
   - the requester's account must be active and still hold the write permission, the tag scope and the reference permissions the change needs;
   - the approvals must still be enough for the policies as they are now (otherwise the request goes back to pending).
6. A pending request expires after the policy's time to live. Approved requests waiting for a window do not expire; the fingerprint check catches anything that changed meanwhile.

If Caddy does not accept the configuration after the change was saved, the request is **applied** with a warning, exactly as a direct change would be saved and reported.

Statuses: `pending`, `approved` (waiting for a window), `applied`, `rejected`, `cancelled`, `expired`, `failed`.

## Impact

Every change request carries an `impact` summary for the people who decide it:

- `hosts`: the one host it changes (a request never changes another), with its domains and whether it is created, changed or deleted.
- `caddy`: Caddy reloads its configuration on this node and, on a master, on every enabled instance outside promotion-only environments (`nodes`, `instances`); instances in promotion-only environments get it only through promotion (`heldBack`). `certificateRequests` lists the new domains of a host without an imported certificate, for which Caddy will request a certificate. `l4PortsChange` says that an L4 host's listening ports change, which must be applied separately and restarts the Caddy container.
- `schedule`: when it applies given the change windows of the policies that cover it now: as soon as it is approved, at the next window after approval (with the time), now (approved and inside the window), waiting for the window, or done.
- `lines`: the three of them in plain sentences.

## Change windows

Times are wall-clock times in the policy's time zone, start included and end excluded. A window whose end is not after its start runs past midnight into the next day (its days are the days it starts); `00:00` to `24:00` is a whole day.

Daylight saving time follows the clock: on a spring-forward night a window inside the skipped hour never opens (02:00–03:00 does not exist that night), and one that overlaps it opens at the first minute that exists (02:30–04:00 opens at 03:00). On a fall-back night a window inside the repeated hour is open for both occurrences (02:00–03:00 lasts two real hours). The request shows when the windows open next.

## Emergency changes

`approvals:emergency` (administrator-level) applies a protected change at once, without approvals and outside the windows, with a reason of at least 10 characters:

- in the dashboard: turn on **Emergency change** in the proxy host editor's review (or the L4 host dialog) and give the reason; the change is submitted and applied in one step;
- on the Approvals page or with `POST /api/v1/change-requests/{id}/emergency { "reason": "..." }`, for any pending or approved request (yours or someone else's).

A policy with `allowEmergency: false` refuses emergency changes (403). Applying still re-checks the host's fingerprint and the requester. The request records `emergency`, the reason and who used it; the audit log has a `change_request_emergency` event before the `change_request_applied` one.

## Paths that are refused instead

Some paths change hosts in bulk or on behalf of another feature; they cannot carry a change request and are refused (409, nothing changed) while a policy covers the host:

- **Other callers of the host models**: the model functions themselves refuse a covered change unless it runs as an approved change. This covers WAF rule suppression for a host (WAF page) and applying an AI tuning suggestion: change the host's WAF exclusions in the proxy host editor instead.
- **Configuration import, backup restore and configuration history rollback**: refused when the new configuration would create, change or delete a protected host (compared by host, with its forward-auth access and mTLS access rules). Importing a configuration that leaves protected hosts as they are works. To restore after an incident, an administrator disables the policies, restores, and enables them again; all of it is audited.

**Instance sync** is not affected: a slave applies the master's configuration as it is, and the master has already enforced its policies. Policies and requests stay on the master; they are not synced, exported or part of configuration history, so a restore can never switch a policy off.

## Permissions

| Permission | What it allows |
| --- | --- |
| `approvals:read` | The Approvals page, the policies, and the change requests on hosts the role can read (within its tag scope), plus your own. Comment; cancel your own requests. |
| `approvals:approve` | Approve, reject and apply other people's requests. A request on a host outside the role's read permission or tag scope answers 404. |
| `approvals:emergency` | Emergency changes. **Administrator-level.** |
| `approvals:manage` | Create, change, disable and delete policies; cancel anyone's request. **Administrator-level.** |

Holding `users:write` together with `approvals:approve` is administrator-level too: it could create a second account to approve one's own changes. Built-in administrators hold every permission, so they can approve other people's changes and make emergency changes, but their own changes still need someone else's approval.

## Alerts

The alert rule type `approval_pending` (see [alerting.md](alerting.md)) fires once for each request waiting for approval, so a Slack, Teams, e-mail or webhook channel can tell the approvers; it resolves when the request is decided or expires. The notification names the host, the operation and the requester's user id, never the requested values.

## REST API

| Method and path | Permission | Notes |
| --- | --- | --- |
| `GET /api/v1/approval-policies` | `approvals:read` | |
| `POST /api/v1/approval-policies` | `approvals:manage` | `201`; `409` for a duplicate name. |
| `GET /api/v1/approval-policies/{id}` | `approvals:read` | |
| `PUT /api/v1/approval-policies/{id}` | `approvals:manage` | Partial. |
| `DELETE /api/v1/approval-policies/{id}` | `approvals:manage` | `204`. |
| `GET /api/v1/change-requests` | `approvals:read` | `?status=open|closed|all|pending|...&mine=true&page=&perPage=` |
| `GET /api/v1/change-requests/{id}` | `approvals:read` | With the field-level `changes`, reviews, window status, the `impact` summary and what the caller may do (`viewer`). |
| `POST /api/v1/change-requests/{id}/approve` | `approvals:approve` | `{ "comment"? }`; `403` for your own request, `409` for a second approval. |
| `POST /api/v1/change-requests/{id}/reject` | `approvals:approve` | `{ "comment" }` required. |
| `POST /api/v1/change-requests/{id}/cancel` | `approvals:read` | Requester or `approvals:manage`. |
| `POST /api/v1/change-requests/{id}/comments` | `approvals:read` | `{ "comment" }`; `201`. |
| `POST /api/v1/change-requests/{id}/apply` | `approvals:approve` | Approved requests, inside the windows (`409` outside). |
| `POST /api/v1/change-requests/{id}/emergency` | `approvals:emergency` | `{ "reason" }`, at least 10 characters. |

The host endpoints answer `202` with the change request on a protected host. To know before writing, send the same body to `POST /api/v1/proxy-hosts/preview` (create) or `POST /api/v1/proxy-hosts/{id}/preview` (update), `proxy_hosts:write`: the answer says whether a policy covers the change, the approvals it needs, the change window and its next opening, whether the caller may apply it as an emergency change, the field changes and the impact. Nothing is stored; see `documentation/proxy-host-editor.md`.

```bash
curl -X POST https://dash.example.com/api/v1/approval-policies -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Production","hostTags":["prod"],"requiredApprovals":2,"timeZone":"Europe/Rome",
       "windows":[{"days":["monday","tuesday","wednesday","thursday"],"start":"09:00","end":"17:00"}]}'
curl -X PUT https://dash.example.com/api/v1/proxy-hosts/12 -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"upstreams":["app-v2:8080"]}'          # 202 {"id": 7, "status": "pending", ...}
curl -X POST https://dash.example.com/api/v1/change-requests/7/approve -H "Authorization: Bearer $OTHER_TOKEN" \
  -H 'Content-Type: application/json' -d '{"comment":"CAB-2026-114"}'
```

## Audit log

| Action | Recorded by |
| --- | --- |
| `approval_policy` create, update, enable, disable, delete | the administrator, with the policy before and after |
| `change_request_created` | the requester, with the covering policies and approvals needed |
| `change_request_approved`, `change_request_rejected`, `change_request_cancelled`, `change_request_commented` | the approver, rejecter, canceller or commenter |
| `change_request_emergency` | the user making the emergency change, with the reason |
| `change_request_applied`, `change_request_failed` | the user applying it (none for the scheduler), with `requestedBy`, `approvedBy`, `via` (approval, manual, scheduler, emergency) and the error |
| `change_request_expired` | none |

The host change itself is recorded as the requester's (`proxy_host` update, ...), as for a direct change.

## Security notes

- Enforcement sits in two layers: the routes and server actions turn a covered change into a request, and the model functions refuse any covered change that is not running as an approved change. A new code path that changes hosts through the models is therefore refused by default rather than bypassing approval.
- Applies run one at a time on the master node. The stored input is applied as it was approved; nothing the requester or approver sends later can change it.
- Approvers see the requested values of a change (as anyone reading the host would), so approval is limited to hosts the approver can read.

## Limits

- Policies protect proxy hosts and L4 proxy hosts, their forward-auth access and mTLS access rules. Shared objects hosts use (certificates, access lists, forward-auth groups and users, mTLS roles, global WAF and other settings, API monetization of a host) are not covered: deleting a group or user still removes its forward-auth grants on a protected host.
- Model validation (upstream format, wildcard certificates, port conflicts) runs when the change is applied; a change it refuses makes the request fail with the reason.
- A request names one change; a dashboard edit is one request even when it changes many fields.
- Requests and their reviews are kept; the audit log is the record of what happened to them.
- The scheduler runs once a minute on the node where the policies are, like the other background jobs; it does not run in a separate process.
