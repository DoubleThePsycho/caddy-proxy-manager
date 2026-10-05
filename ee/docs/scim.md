# SCIM provisioning

Feature id `scim`, Enterprise edition. Source: `ee/scim/` (Elastic License 2.0), with the SCIM 2.0 routes in `routes/scim/v2/` and the dashboard page in `ui/`; `app/scim/v2/` and `app/(dashboard)/scim/` only route to them.

SCIM 2.0 (RFC 7643, RFC 7644) lets your identity provider manage dashboard users. Microsoft Entra ID, Okta or any SCIM 2.0 client can create users, update them, disable them when they leave, and keep forward-auth groups in step. Users created this way have no password: they sign in through your OAuth/OIDC or SAML provider.

## What SCIM can see and change

SCIM only ever sees two kinds of accounts:

- accounts it created itself;
- accounts an administrator explicitly handed to it on the **SCIM provisioning** page (or with `POST /api/v1/scim/users`).

Every other account is invisible: a SCIM `GET` answers `404`, a filter finds nothing, and a SCIM create with the e-mail address of such an account is refused with `409` (`scimType: uniqueness`). An identity provider can therefore never take over a local account by sending its address. Groups work the same way: SCIM sees the forward-auth groups it created and the ones handed to it.

**Protected accounts** can never be changed through SCIM: the primary admin (the `ADMIN_USERNAME` account) and every break-glass account of enforced SSO (whether enforcement is on or not). They cannot be handed to SCIM, and a SCIM user who later becomes a break-glass account is refused with `403`.

## Users

| SCIM attribute | Dashboard |
| --- | --- |
| `userName` | Kept exactly as sent. Unique among SCIM users, compared without case. It is not a sign-in name. |
| `emails` | Kept as sent. The account's e-mail address is the primary address; without one the only address, else the `work` one, else the first. Required. Addresses ending in `@localhost` (forward-auth portal names) are refused. |
| `displayName`, `name.formatted`, `name.givenName`, `name.familyName` | The account name is `displayName`, else `name.formatted`, else given and family name. |
| `externalId` | Kept as sent; used for linking when you choose a claim (below). |
| `active` | `false` disables the account (see Deprovisioning); `true` enables it again. |
| `groups` | Read-only: the SCIM groups the user is in. |

Everything else is accepted and ignored, including the enterprise extension, `title`, `phoneNumbers`, `addresses`, and also **`password`, `roles` and `entitlements`**: SCIM never sets a password, and roles only come from group-to-role mappings.

Nothing is derived. The e-mail address and `userName` are the values the identity provider sent; the account gets no sign-in username (`username` stays empty), so it cannot sign in with a password. The e-mail address is stored the way every account address is: trimmed and lowercased; an address that lowercasing would turn into another one (such as one with the Kelvin sign) is refused.

### Signing in: linking the first SSO sign-in

Choose the **sign-in provider** in the SCIM settings: the OAuth/OIDC provider (the OAuth providers page) or SAML provider (the SAML page, `ee/docs/sso-saml.md`; its id is `saml:<id>` in the API) your users sign in with, normally the same identity provider that sends SCIM. For a SAML provider the assertion's attributes stand in for the claims below: **Link on a claim** names a SAML attribute (for example Entra ID's `http://schemas.microsoft.com/identity/claims/objectidentifier`), and since SAML has no `email_verified` claim, without a claim the first sign-in links only if **Require a verified e-mail** is off (or the identity provider sends an attribute named `email_verified` with the value `true`).

A SCIM user has no linked identity until their first sign-in. Better Auth looks the signing-in identity up by e-mail address and links it to that account only when the provider is trusted (its **Auto-link accounts** switch) or reports the address as verified. For the sign-in provider, the address counts as verified only when every one of these holds (`ee/scim/binding.ts`):

1. the sign-in comes through the provider chosen in the SCIM settings;
2. the address the provider asserts is, apart from case, the address of an **active account that SCIM manages**: never a local account SCIM was not given, never a protected account, never one the identity provider deleted;
3. that account has **no identity of this provider linked yet**, so it is linked once; later sign-ins use the linked identity (OIDC `sub`), and a second identity with the same address is refused;
4. either **Link on a claim** names a claim and that claim equals the user's SCIM `externalId` exactly, or (without a claim) **Require a verified e-mail** is on (the default) and the provider's `email_verified` claim is `true`.

So a provider can link only accounts it provisioned itself (or that an administrator handed to SCIM, which is the administrator's explicit permission), and only through the provider you chose. Keep `AUTH_ALLOW_OAUTH_REGISTRATION` off so that only provisioned users can sign in. If the provider has **Auto-link accounts** on, it links to any account with the same address, as before; the SCIM provisioning page warns about this.

The first link is recorded (`scim_sso_link`) and shown as **First sign-in linked**.

### Roles

Roles never come from SCIM attributes.

- A new SCIM user gets the **default role** from the settings (`user` or `viewer`; default `user`).
- **Group-to-role mappings** map a SCIM group to a built-in role or a custom role. With **Manage roles** on, every SCIM user gets the role of the first mapping (lowest priority number, then oldest) whose group the identity provider put them in, or the default role when none applies. Only memberships the identity provider asserted through SCIM count: adding or removing a member by hand on the Groups page (which `groups:write` allows) changes forward-auth access but never a role. Roles are re-applied when group membership changes through SCIM, when a mapping is added, changed or deleted, and when Manage roles is turned on. Role changes made by hand to a SCIM user are overwritten then. With Manage roles off, mappings are kept but not applied and SCIM never changes a role after creating the user.
- A mapping is a grant: you can only map a role you could assign yourself (only administrators map `admin` or an administrator-level custom role), only to groups SCIM manages, one mapping per group. A mapping to a custom role also needs the `custom_roles` license.
- Protected accounts are never touched. A change that would leave no active administrator (or no break-glass administrator while SSO is enforced) is refused for that user and recorded as `scim_role_change_refused`; the SCIM request that caused it still succeeds.

### Deprovisioning

`active: false` (PATCH or PUT, as a boolean or Entra ID's `"False"`) disables the account and, in the same transaction, deletes its dashboard sessions, its forward-auth sessions (and their exchange codes) and its API tokens. Re-enabling it does not bring the tokens back.

`DELETE /scim/v2/Users/{id}` follows the **delete mode** setting:

- `disable` (default): the account is disabled and revoked as above, and SCIM no longer sees it (`404`). If the identity provider later creates the same `userName` again, the same account comes back.
- `delete`: the account is deleted with everything that belongs to it.

The last active administrator cannot be disabled or deleted (`400`).

SCIM keeps the identity provider's own `active` flag. The account is disabled when the flag turns false and enabled when it turns true again. An administrator who disables a SCIM user in the dashboard is therefore not overruled by a provider that keeps sending `active: true` (Okta sends the whole user on every update).

## Groups

SCIM groups are forward-auth groups (**Groups** page), so membership controls access to forward-auth protected hosts.

On the SCIM provisioning page, the SCIM users and SCIM groups are listed 25 to a page (`?usersPage=`, `?groupsPage=`); the users get a search on name, e-mail and userName once there are more.

- Creating a group whose name a group SCIM does not manage already has is refused with `409`; hand that group to SCIM first if the provider should manage it.
- In a group handed to SCIM, SCIM only sees, adds and removes SCIM users; other members stay and are not shown.
- Members must be SCIM users (`400` otherwise); protected accounts are refused (`403`).
- `DELETE` deletes a group SCIM created (with its memberships and forward-auth grants). For a group handed to SCIM it removes the SCIM members and stops managing the group.

## Setup

1. Configure and enable an OAuth/OIDC provider for your identity provider (the **OAuth providers** page), with **Auto-link accounts** off.
2. Open **Sign-in and directories → SCIM provisioning**. Choose the provider as **Sign-in provider**, pick the delete mode and the default role, turn on **Accept SCIM requests** and save.
3. Create a **SCIM token** and copy it; it is shown once.
4. Optionally hand existing accounts and groups to SCIM, with the exact `userName` the provider sends for each user.
5. Configure the identity provider (below). Once it has pushed groups, add group-to-role mappings and turn on **Manage roles** if roles should follow groups.

The SCIM base URL is `https://<dashboard>/scim/v2` (shown on the page). The dashboard must be reachable from the identity provider over HTTPS.

### Microsoft Entra ID

1. **Enterprise applications → New application → Create your own application** ("Integrate any other application you don't find in the gallery"). Use the same app registration as the OIDC provider or a separate one.
2. **Provisioning → Get started**, mode **Automatic**. **Tenant URL**: the SCIM base URL. **Secret token**: the SCIM token. **Test Connection** (Entra ID asks for a random `userName` and expects no result).
3. **Mappings → Provision Microsoft Entra ID Users**: keep `userPrincipalName → userName`, `mail → emails[type eq "work"].value` (every user needs a `mail`, or map `userPrincipalName` there), `Switch([IsSoftDeleted]…) → active`, `displayName`, `givenName`, `surname`. To link on a claim, change **externalId** to `objectId` and set **Link on a claim** to `oid` in the SCIM settings (Entra ID's ID tokens carry `oid` but no `email_verified`, so without a claim turn **Require a verified e-mail** off only if the OIDC provider's issuer is your own tenant, not `/common` or `/organizations`).
4. **Mappings → Provision Microsoft Entra ID Groups**: keep `displayName`, `objectId → externalId`, `members`.
5. Assign users and groups to the application, set **Provisioning Status** to On and save. Entra ID provisions every 40 minutes; **Provision on demand** tests one user.

Entra ID disables users with `PATCH active "False"` when they are unassigned or soft-deleted and sends `DELETE` after hard deletion.

### Okta

1. **Applications → Browse App Catalog → SCIM 2.0 Test App (OAuth Bearer Token)**, or your own app integration with **Provisioning: SCIM**.
2. **Provisioning → Integration**: **SCIM connector base URL**: the SCIM base URL; **Unique identifier field for users**: `userName`; supported actions: **Push New Users**, **Push Profile Updates**, **Push Groups**; **Authentication Mode**: HTTP Header, **Authorization**: `Bearer <SCIM token>`. **Test Connector Configuration**, save.
3. **Provisioning → To App**: enable **Create Users**, **Update User Attributes**, **Deactivate Users**. Leave **Sync Password** off: passwords are ignored.
4. Okta's SCIM `externalId` is the Okta user id, which is also the OIDC `sub`: set **Link on a claim** to `sub`.
5. Assign people and push groups (**Push Groups → Find groups by name**). To let Okta manage an existing forward-auth group, hand it to SCIM first; Okta then links to it by name.

Okta deactivates users with `PATCH` or `PUT` `active: false` and never sends `DELETE` by default.

## SCIM endpoints

| Path | Methods |
| --- | --- |
| `/scim/v2/ServiceProviderConfig` | GET |
| `/scim/v2/ResourceTypes`, `/scim/v2/ResourceTypes/{id}` | GET |
| `/scim/v2/Schemas`, `/scim/v2/Schemas/{id}` | GET |
| `/scim/v2/Users` | GET (filter `userName eq`, `externalId eq`, `id eq`; `startIndex`, `count` up to 200; `attributes`, `excludedAttributes`), POST |
| `/scim/v2/Users/{id}` | GET, PUT, PATCH, DELETE |
| `/scim/v2/Groups` | GET (filter `displayName eq`, `externalId eq`, `id eq`; `excludedAttributes=members`), POST |
| `/scim/v2/Groups/{id}` | GET, PUT, PATCH, DELETE |

Responses use `application/scim+json`; errors are SCIM error documents (`schemas`, `status`, `scimType`, `detail`). PATCH accepts `add`, `replace` and `remove` in any case, with a path or a path-less object value (Okta's `{"op":"replace","value":{"active":false}}`), paths such as `emails[type eq "work"].value`, `name.givenName`, `members` and `members[value eq "42"]`. Not supported: bulk, sorting, ETags, password changes, filters other than one `eq` comparison.

Every request needs a SCIM token. API tokens and dashboard sessions are refused (`401`), and SCIM tokens are refused by every `/api/v1` endpoint. While **Accept SCIM requests** is off, every request answers `403`.

## Dashboard and REST API

**Provisioning** (`/scim`, permission `scim:read`; changes need `scim:write`) shows the settings, tokens, mappings and the users and groups SCIM manages.

| Method and path | Permission | License | Notes |
| --- | --- | --- | --- |
| `GET /api/v1/scim/settings` | `scim:read` | no | With the SCIM base URL, the providers to choose from and counts. |
| `PUT /api/v1/scim/settings` | `scim:write` | yes, except `{"enabled": false}` | `enabled`, `providerId`, `deleteMode` (`disable`, `delete`), `defaultRole` (`user`, `viewer`), `manageRoles`, `requireVerifiedEmail`, `externalIdClaim`. |
| `GET /api/v1/scim/tokens` | `scim:read` | no | Prefix only. |
| `POST /api/v1/scim/tokens` | `scim:write` | yes | `{name, expiresAt?}`; the `token` is in this response only. At most 20. |
| `DELETE /api/v1/scim/tokens/{id}` | `scim:write` | no | Revokes. |
| `GET /api/v1/scim/role-mappings` | `scim:read` | no | |
| `POST /api/v1/scim/role-mappings` | `scim:write` | yes (and `custom_roles` for a custom role) | `{groupId, role \| customRoleId, priority?}`. |
| `PUT /api/v1/scim/role-mappings/{id}` | `scim:write` | yes | |
| `DELETE /api/v1/scim/role-mappings/{id}` | `scim:write` | no | |
| `GET /api/v1/scim/users` | `scim:read` | no | Users SCIM manages, with `origin`, `deletedAt`, `linkedAt`. |
| `POST /api/v1/scim/users` | `scim:write` | yes | Hand over an account: `{userId, userName, externalId?}`. |
| `DELETE /api/v1/scim/users/{id}` | `scim:write` | no | Stop managing; the account is not changed. |
| `GET /api/v1/scim/groups` | `scim:read` | no | |
| `POST /api/v1/scim/groups` | `scim:write` | yes | Hand over a group: `{groupId, externalId?}`. |
| `DELETE /api/v1/scim/groups/{id}` | `scim:write` | no | Stop managing; members stay, its mapping is deleted. |

`scim:write` is administrator-level: only administrators can give it to a custom role, because its tokens create users and its mappings grant roles.

```bash
curl -X PUT https://dash.example.com/api/v1/scim/settings -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"enabled":true,"providerId":"a1b2c3","externalIdClaim":"sub"}'
curl -X POST https://dash.example.com/api/v1/scim/tokens -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"name":"Okta"}'
```

## License

Turning SCIM on, changing its settings, creating tokens, adding or changing mappings and handing users or groups to SCIM need the license. Turning SCIM off, revoking tokens, deleting mappings and releasing users or groups never do. SCIM requests, linking at sign-in and applying mappings never check it: provisioning that is set up keeps working when the license lapses.

## Audit log

Every SCIM change is recorded with the token that made it: no user, the token's name in the summary and `scimTokenId`, `scimTokenName` in the data (covered by the hash chain). Actions: `scim_user_create`, `scim_user_update`, `scim_user_deactivate`, `scim_user_reactivate`, `scim_user_delete`, `scim_group_create`, `scim_group_update`, `scim_group_members`, `scim_group_delete`, `scim_role_change`, `scim_role_change_refused`. Administrator actions are recorded as theirs: `scim_settings` and `scim_token` `create`/`update`/`delete`, `scim_role_mapping` changes, `scim_user_adopt`, `scim_user_release`, `scim_group_adopt`, `scim_group_release`; and `scim_sso_link` for a first sign-in link.

## Security notes

- SCIM tokens are 256-bit random values with the prefix `scim_`, stored as SHA-256 and shown once. They are a separate credential from API tokens in both directions. Give each identity provider its own token and revoke it when you remove the integration.
- A SCIM token can create users and, through mappings, give them roles; treat it like an administrator credential.
- The linking rules above are the only way a SCIM request influences sign-in. Prefer **Link on a claim** with an immutable identifier (Okta `sub`, Entra ID `oid` with `externalId` mapped to `objectId`); a verified e-mail address is the fallback.
- SCIM settings, tokens, mappings and the users and groups SCIM manages are master-only: like users, they are not synced to slave instances and not part of configuration export or history. Point the identity provider at the master.

## Limits

- Restoring a configuration snapshot or importing a configuration replaces forward-auth groups; a SCIM group that the restored configuration does not have is no longer managed (its mapping no longer applies).
- One sign-in provider per install; one SCIM configuration (several tokens can share it).
- No bulk operations, sorting or ETags; filters are one `eq` comparison on `userName`, `externalId`, `id` (users) or `displayName`, `externalId`, `id` (groups).
- Only core User and Group attributes listed above are kept.
