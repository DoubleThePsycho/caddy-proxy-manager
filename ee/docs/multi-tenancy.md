# Multi-tenancy

Feature id `multi_tenancy`, included in the **MSP** edition. Code: `ee/multi-tenancy/` (Elastic License 2.0). The places where the core enforces it are MIT: the permission catalogue (`src/lib/permissions.ts`), the scope helpers (`src/lib/access-scope.ts`), the models in `src/lib/models/`, the guards in `src/lib/auth.ts` and `src/lib/api-auth.ts`.

For managed service providers. One install serves many client organisations. Each organisation gets its own administrators, proxy hosts, certificates, access lists, forward-auth groups, users, analytics, audit log and usage report, and never sees or affects another organisation.

## Concepts

- **Provider level.** The MSP's own users and every row that belongs to no organisation. Provider-level users with the built-in admin role (and custom roles that hold the permissions) manage all organisations, see every row, and can narrow the dashboard to one organisation with the **organisation switcher** at the top of the sidebar.
- **Organisation.** A client: name, slug, enabled flag, limits (proxy hosts, users) and **allowed upstreams**. A user belongs to the provider level or to exactly one organisation (`users.organizationId`). Proxy hosts, certificates (managed and imported), access lists, forward-auth groups and audit events carry `organizationId` too; API tokens belong to their owner's organisation.
- **Organisation users.** Their role is one of `org_admin` (the organisation administrator), `user` or `viewer`, or a custom role a provider administrator assigned. Whatever the role, they hold at most the **organisation permissions**: `proxy_hosts:read/write`, `certificates:read/write`, `access_lists:read/write`, `groups:read/write`, `users:read/write`, `analytics:read`, `audit_log:read`, `api_docs:read`, `usage_reports:read`. `org_admin` holds all of them. `user` and `viewer` hold none (their profile, their API tokens, forward-auth sign-in to the organisation's hosts).

With no organisations, nothing changes: every row is provider-level, every check passes as before.

## Isolation model

An organisation is a **hard scope next to the role scope**, not a generalisation of it. The role (built-in or custom, with its tag scope, see [custom-roles.md](custom-roles.md)) decides what a user may do; the organisation decides which rows they can ever reach; both apply. Why not tags:

- Tags are host fields that writers can change, and a tag scope only covers proxy hosts, L4 hosts and certificates. An organisation must also own users, groups, access lists, API tokens and audit events, and must be impossible to change for the people it confines.
- A tag scope is a property of a role; an organisation is a property of the user and of each row. Keeping it separate means a provider custom role with a tag scope still works inside or across organisations, and nothing about custom roles had to change.
- The check is one comparison (`row.organizationId == user.organizationId`), easy to apply everywhere and to test.

It is enforced at four layers, so that one missing check does not open a hole:

1. **Permissions** (`accessForUser`, `organizationAccess` in `src/lib/permissions.ts`). An organisation user is never an administrator (`isAdmin` is false), and their permissions are intersected with the organisation permissions on every request. Everything instance-wide or administrator-level (settings, WAF settings, L4 hosts, instances, fleet, license, SSO, LDAP, SCIM, branding, audit streaming, backups, configuration export/import and history, alerts, compliance, change approvals, API monetization, organisations) is out of reach by construction: the routes and pages for them need permissions organisation users cannot hold, and `requireAdmin` needs `isAdmin`.
2. **Routes, actions and pages** filter lists and look rows up with the caller's access (`findProxyHostInScope`, `getAccessListInScope`, `findGroupInScope`, `findUserInScope`, `certificateIdsInScope`, `organizationFilterFor`). A row of another organisation (or of the provider level) answers **404**, exactly like a missing one.
3. **Models** refuse a write by an organisation user on a row of another organisation (`assertActorReaches`, 404), whatever path called them (REST, dashboard, change approvals, imports), and keep the invariants below for every writer.
4. **Database.** Triggers refuse any user row that is both in an organisation and `admin`, or provider-level and `org_admin`.

Invariants the models keep for every writer, provider level included:

- A proxy host uses only a certificate and an access list of its own organisation.
- Forward-auth access on a host only names users and groups of the host's organisation; a group only has members of its own organisation.
- **Domains are unique across organisations** (the provider level counts as one): a name one organisation serves, or holds a certificate for, cannot be served or certified by another. Equal names and wildcards that cover a name (one label, as Caddy matches) clash. Imported certificates count with the names in their PEM, because Caddy picks a loaded certificate by its names, not by what the form said.
- Group names are unique per organisation.
- An organisation never holds more proxy hosts or users than its limits.

## What organisation users can and cannot do

They manage their organisation's proxy hosts, managed and imported certificates, access lists, forward-auth groups and users, read its analytics, audit log (export included, with the license for audit export) and usage report, and use their own API tokens, which act within the organisation.

On a proxy host they **cannot set** (refused in the model, `403`):

- custom reverse-proxy JSON and custom pre-handlers JSON (raw Caddy configuration);
- raw WAF directives (`waf.custom_directives`, SecLang can read and write files and switch the engine off);
- mTLS (it trusts the provider's CA and client certificates) and mTLS access rules;
- custom DNS resolvers (they decide what an allowed upstream name resolves to);
- an upstream outside the organisation's **allowed upstreams**. This covers upstreams, location-rule upstreams, and the Authentik outpost and forward-auth servers. Unix sockets, Caddy placeholders and Caddy's admin API port (2019) are never allowed, and load-balancer health checks cannot probe port 2019 either.

Keeping a value the provider set is fine, and clearing a raw field is allowed. They cannot see or touch L4 hosts, CA certificates, client certificates, mTLS roles, custom roles, the approvals page, or any other organisation's anything. They cannot verify the audit log's hash chain (it spans every organisation).

### Allowed upstreams

Caddy reaches every network the provider runs it in, including other tenants' backends and internal services. Without a limit, an organisation could publish another tenant's backend under its own domain and skip that tenant's authentication. Each organisation therefore lists where its users may proxy to, one entry per line:

| Entry | Allows |
| --- | --- |
| `app.example.com` | that host name |
| `*.example.com` | any name under `example.com`, any depth |
| `10.20.0.0/16`, `10.20.0.5`, `2001:db8::/32` | IP addresses in the range |
| `*` | any network upstream: the provider accepts the risk |

An empty list allows nothing, so a new organisation proxies nowhere until the provider decides. Host names are matched as written: the provider vouches for what they resolve to. Provider-level users are not limited, also when they edit an organisation's host.

### Forward auth

`checkHostAccess` (every portal sign-in and every forward-auth check) lets a user through only on hosts of their own organisation (provider-level users only on provider-level hosts), and nobody of a disabled organisation, whatever the grants say. Only groups of the user's own organisation count, and only those are sent to the upstream in the groups header. A portal sign-in of a user of organisation A therefore never grants access to organisation B's hosts.

### Disabled organisations

Disabling an organisation (no license needed) ends its users' dashboard and forward-auth sessions; afterwards they cannot sign in (password, SSO, LDAP and the portal answer like wrong credentials), their API tokens stop working and forward auth refuses them. Its hosts keep serving traffic; disable them separately if needed.

## Scoping, surface by surface

| Surface | Organisation users | Provider level |
| --- | --- | --- |
| Proxy hosts: `GET/POST /api/v1/proxy-hosts`, `GET/PUT/DELETE /{id}`, forward-auth access, dashboard page and actions | Own organisation's; others 404; new hosts in their organisation; forbidden fields and upstreams refused | Every host, `?organizationId=` filter, `organizationId` on create |
| mTLS access rules | Read on own hosts; changes 403 | As before |
| L4 proxy hosts | Not available (no permission; scope helpers answer 404) | As before |
| Certificates: REST, dashboard page and actions | Own organisation's; others 404; names checked across organisations | Every certificate |
| CA / client certificates, mTLS roles | 403 | As before |
| Access lists: REST, entries, rules, dashboard | Own organisation's; others 404; an entry or rule is only changed in its own list | Every list |
| Blocked sources (the global access list) | Refused (403): it applies to every organisation's hosts | Yes |
| Groups and members | Own organisation's; members only of the organisation | Every group |
| Users: REST, MFA reset, dashboard | Own organisation's users; roles `org_admin`, `user`, `viewer` | Every user; `organizationId` on create |
| Custom roles (`/api/v1/roles`) | 403 | As before |
| Forward-auth sessions | Own organisation's users' | Every session |
| API tokens | Own tokens | Administrators: every token |
| Audit log list and export | Events of their organisation (actors outside it shown as the provider) | Every event, `?organizationId=` filter |
| Audit log verification | 403 | As before |
| Analytics (`/api/v1/analytics/*` and the Analytics page) | Host names of their organisation only, whatever the filters ask for (no hosts means no data) | Every host, or the switcher's organisation |
| Usage reports | Own organisation | Every organisation and the provider level |
| Change approvals | Policies hidden; protected changes become change requests decided by provider approvers | As before |
| Compliance reports, alerts, WAF, fleet, settings, backups, exports and imports, SSO, LDAP, SCIM, access reviews, monetization, branding, license | Not available | As before; they cover every organisation |

Audit events are attributed when recorded: an event about a proxy host, certificate, access list, group or user belongs to that row's organisation (whoever acted, the provider included); anything else to the organisation of the user who acted. Moves record one event in the organisation a row leaves and one in the one it joins. The attribution is not part of the hash chain.

## Setting up

1. Install an MSP license (**License**).
2. **Organisations → New organisation**: name, slug (derived from the name when left empty), limits and allowed upstreams.
3. Put rows into it: **Move rows in** lists hosts, certificates, access lists, groups and users of the provider level and of other organisations. A host moves together with its certificate and access list (the move is refused otherwise). Or create rows while the switcher shows the organisation: new hosts, certificates, access lists, groups and users then go into it.
4. Give the organisation an administrator: create a user in it with the `org_admin` role (Users page with the switcher on the organisation, or `POST /api/v1/users` with `organizationId`), or move an existing user in.

Moved users get a role that fits: `admin` becomes `org_admin`, a custom role holding more than the organisation permissions becomes `viewer`, and moving a user out to the provider level always leaves `viewer` (never provider access by accident). You cannot move your own account, the primary administrator, a break-glass account, or the last active administrator. Group members, forward-auth grants and forward-auth sessions that would cross organisations are removed (the result says how many).

Deleting an organisation is refused while it owns proxy hosts, certificates, access lists, groups or users.

## The Organisations page

The list shows each organisation's proxy hosts and users against its limits (a bar turns amber at 80% of a limit), its allowed upstreams, its requests in the last full calendar month and whether it is enabled (a disabled one says since when, from the audit log). **Near a limit** narrows the list to organisations at 80% or more of either limit; a limit of 0 counts as reached. The footer counts the hosts and users that belong to no organisation.

Opening an organisation (its name in the list, or `/organizations?organization=<id>`) shows its limits, its allowed upstreams with what each entry admits, its usage for the last full month with a CSV link and the current month so far, its hosts with their protections and its members with their role and last sign-in. **Show only this organisation** sets the organisation switcher to it; **Open in proxy hosts** and **Add user** do the same and open that page.

What the page shows follows the viewer's permissions: usage figures need `usage_reports:read`, and the host list needs `proxy_hosts:read` (a role scoped to tags sees only its tagged hosts).

## Usage reports

**Usage** (and `GET /api/v1/usage-reports`, `?format=csv` for billing) shows, per organisation and period (a calendar month, or `from`/`to`): proxy hosts (and how many are enabled) and users now, requests, bytes served and WAF blocks in the period. Traffic is counted over the host names the organisation serves now (exact domains and names its wildcards cover, port and case ignored), from ClickHouse, so only as far back as analytics retention (90 days by default) and nothing when analytics are off. Traffic of a domain counts for its current owner.

## License

| Action | License |
| --- | --- |
| Create an organisation; change one (name, slug, limits, allowed upstreams, notes, enabling) | `multi_tenancy` required (`403` otherwise) |
| Move rows into an organisation; create a row inside one as a provider-level user | required |
| Disable or delete an organisation; move rows out to the provider level | never |
| Organisation users signing in and working in their organisation | never |
| Isolation (every check above) | never: it stays enforced when the license lapses |
| Reading organisations and usage reports | never |

## Permissions

| Permission | Who | Covers |
| --- | --- | --- |
| `organizations:read` | Provider level | Organisations, their members and counts; the organisation switcher |
| `organizations:write` | Provider level, **administrator-level** | Create, change, disable, delete organisations; move rows; create rows inside one |
| `usage_reports:read` | Both | Usage reports (organisation users: their own) |

## REST API

| Method and path | Permission | Notes |
| --- | --- | --- |
| `GET /api/v1/organizations` | `organizations:read` | With counts of what each owns |
| `POST /api/v1/organizations` | `organizations:write` | `{name, slug?, enabled?, maxProxyHosts?, maxUsers?, allowedUpstreams?, notes?}`; license; `201`; `409` for a slug in use |
| `GET /api/v1/organizations/{id}` | `organizations:read` | |
| `PATCH /api/v1/organizations/{id}` | `organizations:write` | Partial; license unless only `{"enabled": false}` |
| `DELETE /api/v1/organizations/{id}` | `organizations:write` | `409` while it owns rows; no license |
| `GET /api/v1/organizations/{id}/members` | `organizations:read` | Its users |
| `POST /api/v1/organizations/{id}/members` | `organizations:write` | `{userIds}`: move users in; license |
| `POST /api/v1/organizations/move` | `organizations:write` | `{organizationId (null: provider level), proxyHostIds?, certificateIds?, accessListIds?, groupIds?, userIds?}` |
| `GET /api/v1/usage-reports` | `usage_reports:read` | `?month=YYYY-MM` or `?from=&to=`, `?organizationId=`, `?format=csv` |

Lists of proxy hosts, certificates, access lists, groups, users, forward-auth sessions and the audit log take `?organizationId=<id>` (or `provider`) for provider-level callers; organisation users always get their own. Creating a proxy host, certificate, access list, group or user takes `organizationId`. Rows carry `organizationId` in responses (certificates only when set).

```bash
curl -X POST https://dash.example.com/api/v1/organizations -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Acme","maxProxyHosts":20,"allowedUpstreams":["*.acme.example.com","10.20.0.0/16"]}'
curl -X POST https://dash.example.com/api/v1/organizations/move -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"organizationId":1,"proxyHostIds":[4,5],"certificateIds":[2],"userIds":[9]}'
curl -X POST https://dash.example.com/api/v1/users -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@acme.example.com","password":"…","role":"org_admin","organizationId":1}'
curl -o usage.csv "https://dash.example.com/api/v1/usage-reports?month=2026-09&format=csv" -H "Authorization: Bearer $TOKEN"
```

## Instance sync, fleet, configuration history

Replicas receive every organisation's hosts (the data plane is shared), with their `organizationId`; organisations and users are master-only and are not synced, so there are no organisation users on a replica. Organisation users cannot touch instances or fleet. Configuration history restores keep `organizationId` while the organisation exists (ids are never reused); a configuration import, and so a backup restore, puts every row at the provider level, because the ids may name another installation's organisations. No settings group was added, so nothing new needs instance sync.

## Threat model

Attackers considered, and what stops them:

- **A user of organisation A (any role, any API token) reading or changing organisation B's rows**: permission intersection, route scoping, model reach checks; 404 everywhere; tested for every resource and operation (`tests/integration/multi-tenancy-isolation.test.ts`).
- **Escalating to provider or administrator access**: organisation users never get `isAdmin` or a permission outside the organisation set; `org_admin` cannot be granted to provider-level users nor `admin` to organisation users (escalation guards and a database trigger); organisation users cannot manage or assign custom roles; identity provider claims cannot set `organizationId`; LDAP and SCIM never link to or change the role of organisation users; moving a user out of an organisation leaves `viewer`.
- **Injecting configuration into the shared Caddy**: raw JSON, raw WAF directives, mTLS, DNS resolvers and upstreams are refused as above; host-level response content (error pages, path blocks, redirects) has file, environment and system placeholders escaped and paths stripped of placeholders, for every non-administrator.
- **Taking another tenant's traffic or certificate**: domains and certificate names are unique across organisations, wildcards and PEM names included; certificates and access lists are only usable within their organisation.
- **Reaching another tenant's backend**: allowed upstreams.
- **Crossing through forward auth**: tenant check in `checkHostAccess`; grants and group members stay within one organisation.
- **Reading other tenants' traffic**: analytics and usage are restricted to the organisation's host names, and a request naming another tenant's host gets nothing.
- **Learning about other tenants from the audit log**: events are attributed to one organisation; the provider's staff are shown as "Provider".

## Out of scope (not isolated, by design)

- **L4 proxy hosts** stay provider-level: listening ports are one namespace for all tenants (and published by the container), so they could collide.
- **Global login identifiers.** E-mail addresses and usernames are unique across the install (the login page is shared), so creating a user whose address another organisation uses is refused, which tells that the address exists somewhere. Domains likewise: a refused domain tells that someone serves it.
- **Domain ownership.** Domains are first come, first served across organisations; nothing proves that an organisation owns a domain it adds. A wildcard of one tenant blocks the names it covers for every other tenant; to give organisations subdomains of your zone, do not keep a wildcard host or certificate for that zone at the provider level. DNS-01 challenges use the provider's DNS credentials for any name an organisation adds.
- **Network isolation** beyond allowed upstreams: a host name in the list resolves to whatever DNS says; DNS rebinding of a name you allowed is the provider's risk. `*` allows everything.
- **Shared data plane.** Tenants share Caddy's resources (CPU, memory, connections, the WAF engine and its global rules, global settings, default responses and error pages for unknown hosts, rate limits). A tenant can load the shared Caddy; there are no per-tenant quotas besides host and user limits.
- **Provider-level identity sources.** SSO, LDAP and SCIM are configured by the provider and can sign in as organisation users once linked; organisations cannot bring their own identity provider.
- **Change approvals, alerts, compliance reports, AI analyst, WAF events and tuning, monetization** remain provider-level features that cover every organisation; organisation users do not get them (a protected change of theirs waits for a provider approver).
- **Audit hash chain**: the attribution column is not covered by the hash, and an organisation's export cannot be verified on its own (verification spans every event, provider level only).
- **Historical accuracy**: audit events keep the organisation they were recorded with; analytics follow current ownership.
- **Inside an organisation** its administrators are peers: one can demote or delete the others. The provider can always step in.
- **New host fields.** A host field added later that reaches beyond the host (raw configuration, addresses Caddy connects to, files) must be added to `assertOrganizationHostInput` (`ee/multi-tenancy/hosts.ts`).
- **Triggers** are dropped if a future migration rebuilds the `users` table; such a migration must recreate them.
