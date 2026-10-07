# Access reviews

Source: `ee/access-reviews/` (Elastic License 2.0), with its pages in `ui/` and its API routes in `routes/`; `app/(dashboard)/access-reviews/` and `app/(dashboard)/my-reviews/` only route to them.

Access reviews (access recertification) make named reviewers confirm, at a due date and on a schedule, that every user still needs the access they have. What they revoke is removed when they confirm, and every campaign leaves a record you can download for an audit (ISO 27001 A.5.18, NIS2 access control, SOC 2 CC6).

## Campaigns

A campaign has a name, a scope, reviewers and a due date. When it starts, it takes a snapshot of every access of the **active** users in scope, one item each:

| Item | Revoking it |
| --- | --- |
| Account (the dashboard account itself) | Disables the account and ends its dashboard and forward-auth sessions. |
| Role: the built-in admin role or a custom role | Changes the role to the built-in viewer role. |
| Group: each forward-auth group membership | Removes the user from the group. |
| API token: each of the user's API tokens | Deletes the token. |

Users with the built-in user or viewer role have no role item; their account item covers them.

**Scope:** all active users, or the users who have any of the chosen built-in roles, custom roles or groups. Every access of a user in scope is reviewed, not only the access that put them in scope.

**Reviewers:** 1 to 50 active users. Any of them can decide any item, except that **nobody reviews their own access**: a reviewer's own items are shown but cannot be decided, and another reviewer has to decide them. Starting a campaign is refused (`400`) when a user in scope is its only reviewer, or when nobody is in scope.

## Reviewing

Being named as a reviewer is all a reviewer needs; no permission is required. Reviewers see a reminder on every dashboard page and decide in **My reviews** (`/my-reviews`):

1. Choose **Keep** or **Revoke** for each item, with an optional comment. These are drafts and can be changed.
2. **Confirm**. Revocations are applied now, through the same functions as manual changes on the Users and Groups pages and their guards: the last active administrator cannot be demoted or disabled, and the last break-glass administrator of enforced SSO stays until it is taken off the break-glass list. Each item records its outcome:
   - `kept`, `revoked`;
   - `unchanged`: the access was already gone or had changed since the campaign started (for example the role was changed by hand), so nothing was done;
   - `failed`: a guard refused it; the reason is shown.

Items are claimed before they are applied, so confirming twice never applies anything twice, and confirmed items cannot change. When the last item is confirmed the campaign is **completed**.

For users managed by SCIM ([scim.md](scim.md)) the identity provider stays the source of truth: with **Manage roles** on, a revoked role comes back on the provider's next change, and revoking a membership of a SCIM group removes forward-auth access but not a role mapped to the group. Remove the user from the group in the identity provider too.

## Evidence

So reviewers decide from facts, every item comes with evidence read from the audit log and the accounts when it is asked for (never stored with the campaign):

- for each person: how the account signs in (`sources`: password, an OAuth/OIDC provider, an LDAP directory, a SAML provider, SCIM provisioning), whether it has MFA, the last sign-in and the sign-ins of the last 30 days, the last change they made (the newest audit event that changed something; sign-ins, exports, checks and reports do not count), and `roleManagedBy` when a directory or provider with a group-to-role mapping sets the role at each sign-in (a revoked role would come back);
- for each item, when that access was last used: the account's last sign-in, the role's last change, the group's last forward-auth sign-in to a host the group grants, the API token's last request; and a note such as "No change in the last 90 days", "Never used" or "The token no longer exists".

`GET /api/v1/access-reviews/{id}/evidence` (`access_reviews:read`) returns it for any campaign; `GET /api/v1/access-review-assignments/evidence?campaignId=` returns it to a reviewer of the open campaign (no permission; any other campaign answers 404).

## Closing, overdue and records

- **Overdue:** an open campaign past its due date with pending items is flagged overdue, and so are its pending items.
- **Complete** closes an open campaign early: items nobody confirmed are recorded as `not_reviewed` and their access stays.
- **Cancel** stops a campaign: nothing more can be decided or revoked. Revocations already confirmed stay.
- **Delete** removes the campaign and its items. The audit log keeps the events.
- **Record:** CSV or JSON with every item, its decision, comment, reviewer, decision and confirmation times and outcome. Available while the campaign is open (interim) and final once it is completed. CSV cells that a spreadsheet would run as a formula start with an apostrophe.

## Schedules

**Repeat** in **Start review** creates a schedule: a new campaign every `intervalMonths` months (1-36, default 3), due `durationDays` days after it starts (1-365, default 14, shorter than the interval), with the schedule's scope and reviewers. The first campaign starts at once (or at `firstRunAt`). Campaign names get the start date. A run that cannot start (nobody in scope, a user in scope who is the only reviewer) is shown as the schedule's last error and the schedule waits for its next run. Schedules run on the master, checked every five minutes.

## Alerts

With [alerting](alerting.md), two rule types notify any channel:

- `access_review_started`: a campaign is open (fires once when it starts, resolves when it is completed or cancelled);
- `access_review_overdue`: an open campaign is past its due date with pending items.

## Dashboard and REST API

**Access reviews** (`/access-reviews`, permission `access_reviews:read`) lists campaigns with their progress (25 to a page, `?page=`), and schedules. In **Start review**, the reviewer and group lists get a search once they are long. A campaign's page shows its progress (keep, revoke and pending, drafts lighter than confirmed decisions), its due date, scope and reviewers, the record downloads, and every person with their access: how the account signs in, its last sign-in and sign-ins in 30 days, the last change they made, whether they have a second factor, and when each access was last used, 25 people to a page (the campaign page keeps the page in the address) with a search on names and e-mail addresses once there are more. A role that a directory, SAML provider or SCIM sets at each sign-in is flagged, because revoking it here does not last. A reviewer of the open campaign chooses **Keep** or **Revoke** for each item there (a draft, saved at once), adds a comment and confirms; **My reviews** (`/my-reviews`) shows the same for every open campaign they review, with no permission needed. Starting, scheduling, completing, cancelling and deleting need `access_reviews:write`, which is **administrator-level**: a campaign's reviewers can take access away from any user, administrators included, so only administrators can give it to a custom role.

| Method and path | Permission |
| --- | --- |
| `GET /api/v1/access-reviews` | `access_reviews:read` |
| `POST /api/v1/access-reviews` `{name, scope?, reviewerIds, dueAt}` | `access_reviews:write` |
| `GET /api/v1/access-reviews/{id}` | `access_reviews:read` |
| `DELETE /api/v1/access-reviews/{id}` | `access_reviews:write` |
| `POST /api/v1/access-reviews/{id}/complete` | `access_reviews:write` |
| `POST /api/v1/access-reviews/{id}/cancel` | `access_reviews:write` |
| `GET /api/v1/access-reviews/{id}/record?format=csv\|json` | `access_reviews:read` |
| `GET /api/v1/access-reviews/{id}/evidence` | `access_reviews:read` |
| `GET /api/v1/access-review-schedules`, `GET …/{id}` | `access_reviews:read` |
| `POST /api/v1/access-review-schedules` `{name, scope?, reviewerIds, durationDays?, intervalMonths?, firstRunAt?}` | `access_reviews:write` |
| `PUT /api/v1/access-review-schedules/{id}` | `access_reviews:write` |
| `DELETE /api/v1/access-review-schedules/{id}` | `access_reviews:write` |
| `GET /api/v1/access-review-assignments` | named reviewers (any signed-in user or API token) |
| `PUT /api/v1/access-review-assignments/{itemId}` `{decision: "keep" \| "revoke" \| null, comment?}` | reviewers of the item's campaign |
| `POST /api/v1/access-review-assignments/confirm` `{campaignId}` | reviewers of the campaign |
| `GET /api/v1/access-review-assignments/evidence?campaignId=` | reviewers of the open campaign |

`scope` is `{"type":"all"}` (default) or `{"type":"filter","roles":["admin"],"customRoleIds":[3],"groupIds":[7]}`. Items of campaigns the caller does not review answer `404`; the caller's own access answers `403`; a confirmed item or a closed campaign `409`.

```bash
curl -X POST https://dash.example.com/api/v1/access-reviews -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Q4 admins","scope":{"type":"filter","roles":["admin"]},"reviewerIds":[4,7],"dueAt":"2026-12-15T23:59:59Z"}'
curl -o review-12.csv "https://dash.example.com/api/v1/access-reviews/12/record?format=csv" -H "Authorization: Bearer $TOKEN"
```

## Audit log

`access_review_started` (with the schedule for scheduled runs), `access_review_decisions` (each confirmation, with counts), `access_review_revoke` (each revocation with its outcome, by the reviewer), `access_review_completed` (with the outcome counts), `access_review_cancelled`, `delete` of an `access_review`, and `create`/`update`/`delete` of an `access_review_schedule`. A group removal is also recorded by the Groups model as usual.

## Limits

- Direct per-host forward-auth grants to a user are not separate items; the account item covers them (disabling the account ends forward-auth access).
- A campaign reviews the access users have when it starts; access granted later waits for the next campaign.
- Campaigns, items and schedules are master-only: not synced to slave instances and not part of configuration export or history.
