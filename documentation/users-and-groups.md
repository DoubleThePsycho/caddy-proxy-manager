# Users and groups

**Users and groups** (Identity in the sidebar) has three tabs: **Users**, **Groups** and **Roles**. `/users` opens the first, `/groups` the second and `/users?tab=roles` the third; `/users?user=<id>` opens a user's panel. Each tab needs its own permission: Users `users:read`, Groups `groups:read`, Roles `users:read` at the provider level. It is part of the Community edition; custom roles need a license.

## Users

One row per account:

- **User:** name, e-mail and sign-in username. Tags mark you, the primary admin (the account `ADMIN_USERNAME` manages) and break-glass accounts of enforced SSO.
- **Role:** a built-in role or a custom role with its permission count and tag scope. When an LDAP directory or SAML provider with group mappings, or SCIM with **Manage roles**, sets the role, the line says so: a role you choose here is replaced at their next sign-in.
- **Comes from:** Local (a password), OIDC, SAML, LDAP and SCIM, with the provider or directory by name. An account with none of them only uses API tokens.
- **Second factor:** authenticator app, passkey, at the identity provider (the account signs in only through OIDC or SAML, so the provider asks for its own), not needed (it cannot sign in to the dashboard), or **None**. None is red for administrators and for accounts the MFA policy has locked out.
- **Last sign-in:** when and how the last dashboard sign-in completed. A token-only account shows when one of its API tokens was last used.
- **Status:** active, invited (never signed in, no token used) or disabled, with the date it was disabled. The date is recorded whichever way the account was disabled (here, the REST API, SCIM or an access review); accounts disabled before Ingressi recorded it show no date.

Search looks in names, e-mails, usernames, roles and sources. **Administrators** lists the admin role, organisation administrators and administrator-level custom roles; **Invited or disabled** the accounts nobody uses.

A banner names any active administrator who can sign in with a password and has no second factor, with **Change role** and **Disable account**. The MFA policy line under it opens **Edit policy** (`mfa_policy:write`); see `documentation/mfa.md`.

### A user's panel

Click a name, or **Open details** in the row menu:

- **Role:** change it (`users:write`). You cannot change your own.
- **Details:** name, e-mail and the sign-in username, saved together.
- **Multi-factor authentication:** authenticator app with backup codes left, passkeys and what the policy asks. **Reset MFA** removes all of them; their sessions are kept.
- **Sessions:** every browser signed in, with device, place and times. **Sign out** ends one; **Sign out everywhere** ends all (for your own account, all but this one). API tokens are not affected.
- **Account:** **Disable user** ends their dashboard and forward-auth sessions and stops their API tokens until you enable them again; **Delete user** removes the account.

Every change is recorded in the audit log, and the same guards apply as through the REST API: you cannot change your own role or status, the last active administrator stays, and enforced SSO keeps a break-glass administrator.

**Add user** creates a local account with a password. Directory, SAML and SCIM accounts arrive on their own.

## Groups

Forward-auth groups decide who gets through the sign-in portal of hosts protected by forward auth. Every request to such a host checks the user's access again, so removing a member, deleting a group or taking a host's grant away refuses the next request. With high availability shared state (Enterprise, `ee/docs/high-availability.md`) the sessions this takes access from are also ended on every web node at once. Each row shows the members, whether SCIM manages the group, the dashboard role a SCIM group-to-role mapping gives (with `scim:read`) and the hosts that let the group in (with `proxy_hosts:read`, only hosts in your tag scope). **Manage members** adds and removes people; **Edit group** renames it. A name is required, at most 100 characters and unique in its organisation; when a change is refused, the dialog says why (the name is taken, the person is already a member, the group is gone), and `POST /api/v1/groups` and `PATCH /api/v1/groups/{id}` refuse the same input with 400 or 409, and adding a member twice answers 409.

Adding someone to a SCIM group by hand changes what they can reach, never their role: only memberships the identity provider sends count for role mappings.

## Roles

Built-in roles are described; custom roles show their permissions grouped by area, their tag scope and who holds them. See `ee/docs/custom-roles.md`.

## REST API

| Method and path | Permission | What |
| --- | --- | --- |
| `GET /api/v1/users/overview` | `users:read` | Every account as the Users tab shows it: `sources`, `secondFactor`, `roleManagedBy`, `administrator`, `breakGlass`, `primaryAdmin`, `apiTokenLastUsedAt`, and the MFA policy (null without `mfa_policy:read`). `?organizationId=` filters like `GET /api/v1/users`. |
| `GET /api/v1/groups/overview` | `groups:read` | Every group with members, `scim`, `roleMappings` (null without `scim:read`) and `hosts` (null without `proxy_hosts:read`). |
| `GET /api/v1/users/{id}/sessions`, `DELETE …` | `users:read`, `users:write` | A user's sessions; see `documentation/profile.md`. |
| `GET /api/v1/users/{id}/mfa`, `DELETE …` | `users:read`, `users:write` | A user's MFA state and the reset; see `documentation/mfa.md`. |

Neither overview returns a password hash, secret or token value.
