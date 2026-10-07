# LDAP / Active Directory sign-in

Source: `ee/ldap/` (Elastic License 2.0).

People sign in to the dashboard with their LDAP or Active Directory account. Directory groups can decide their role. One installation can have several directories.

## What it covers

- **Dashboard sign-in only.** The forward-auth portal (`/portal`) is not affected.
- **Sign-in** is a Better Auth endpoint, `POST /api/auth/sign-in/ldap`. The session is created the standard way, so everything that applies to other sign-ins applies here too:
  - disabled accounts are refused;
  - new accounts get safe defaults (role `user`, status `active`, no custom role) before the group mapping is applied;
  - the second factor, the MFA policy and enforced SSO apply (see below);
  - every sign-in is recorded in the audit log.
- **Not covered:** API tokens. They are separate credentials and keep working.

## How sign-in works

1. An empty or blank password is refused before anything is sent. A simple bind with an empty password is an "unauthenticated" bind, which many servers accept as a success.
2. The service account binds and searches the user search base with the user filter. `{username}` in the filter is replaced with what the person typed, escaped per RFC 4515, so `*`, `(`, `)`, `\` and NUL are always literals. Exactly one entry must match.
3. A second connection binds as that entry's DN, exactly as the directory returned it, with the typed password. A DN is never built from what someone typed.
4. Only then are the entry's attributes and groups read, with the service account.

The answer never tells why a sign-in failed. An unknown user, a wrong password, several matching entries, a user outside the required group, an account that may not be linked or created, a disabled account and a refusal under enforced SSO all get `401 Invalid username or password`.

- **Unknown users take as long as wrong passwords.** Without a single matching entry, the second connection binds to a DN that cannot exist, so the server work and the timing match a wrong password.
- **A directory that cannot be reached** answers `503 The directory is not available`. That only happens before the password is checked, so it reveals nothing about the account.
- **Refusals after a correct password can take longer.** The groups are read only once the password is accepted, so a user outside the required group, or an account that may not be linked or created, can get the same answer a little later than a wrong password.

### Transport

- **Encryption:** use `ldaps://`, or `ldap://` with StartTLS. StartTLS upgrades the connection before anything else is sent.
- **Certificates:** the server certificate is always verified, against the system trust store or the directory's CA certificate. Its name must match the host in the URL. TLS 1.2 is the minimum. There is no switch to turn verification off.
- **Unencrypted connections:** `ldap://` without StartTLS is refused unless **Allow unencrypted connections** is on for that directory. The dashboard and the API then show a warning. Use it only for a directory on the same host or a trusted private network: the service account password and every user's password cross the network in clear text.
- **No silent reconnect:** a connection is never re-opened after it drops. A reconnect would skip StartTLS, so the operation fails instead.
- **Timeouts:** each directory has a connect timeout and an operation timeout. Searches ask for at most two users. Group lookups stop at 1000 groups; more fail closed.

### Rate limiting

Directory sign-in uses the dashboard's login limiter (`LOGIN_MAX_ATTEMPTS`, `LOGIN_WINDOW_MS`, `LOGIN_BLOCK_MS`):

- failures per client;
- failures per client and username;
- failures per username from all clients, up to a ceiling of at least ten times the per-client limit.

Better Auth's own limit on `/api/auth/sign-in/*` (3 requests per 10 seconds per client) applies on top. A limited request gets `429`.

## Accounts

A directory account is an `accounts` row with provider id `ldap:<directory id>`. Its account id is the entry's **stable unique id**, not its DN, so renaming or moving the entry keeps the link.

- **Unique id:** `entryUUID` (OpenLDAP and most servers) or `objectGUID` (Active Directory, stored in its GUID form). The entry must have exactly one value.
- **Provider id:** the colon cannot occur in an OAuth provider id, so a directory never shares a namespace with an OAuth provider.

At sign-in, the account is found in this order:

1. **Linked account:** the account already linked to the entry in this directory.
2. **Existing account** with exactly the same e-mail address, compared without case as everywhere in Ingressi. Only when **Link existing accounts** is on (off by default). Never:
   - the primary admin (the account created from `ADMIN_USERNAME`);
   - a break-glass account of enforced SSO, whether enforcement is on or not;
   - an administrator or a user with a custom role: an e-mail match must not hand over privileges. Give directory users their role through a group mapping instead;
   - a disabled account;
   - an account already linked to another entry of the same directory.

   Turning linking on means: whoever controls an e-mail address in the directory can sign in to the account that has it.
3. **New account**, only when **Create accounts at first sign-in** is on (off by default) and the entry has an e-mail address. Consider a required group (below).

Otherwise the sign-in is refused.

### What a new account gets

- **E-mail address and display name** come only from the attributes the administrator chose, exactly as returned. Nothing is derived from the username.
- **No local username or password.** The login page's own username is never set from the directory.
- **Later sign-ins** update the display name. The e-mail address stays what it was when the account was created or linked.

## Groups and roles

- **Group lookup:**
  - `member_of` reads an attribute of the user (default `memberOf`).
  - `search` searches a group base with a filter. `{dn}` is the user's DN and `{username}` the username attribute, both escaped.
  - **Nested groups** (Active Directory): with `member_of`, every group the user is in, directly or through other groups, is found with `LDAP_MATCHING_RULE_IN_CHAIN` below the group search base.
- **The mapping is the only way a directory grants a role.** It is an explicit list of group DN to role (`admin`, `user`, `viewer`). No attribute of the entry is ever read for a role, not even one named `role`. Group DNs are compared without case and without the spaces around separators.
- **With at least one mapping, the directory decides the role at every sign-in:**
  - the highest role of the user's mapped groups, otherwise the **default role** (`user` or `viewer`, never `admin`);
  - it demotes as well as promotes, and takes a custom role away;
  - changes made on the Users page are overwritten at the next sign-in.
- **Without mappings,** a new account gets the default role and roles are managed on the Users page.
- **Required group:** only its members can sign in.
- **Never changed by a directory:** the primary admin and break-glass accounts. A demotion that would leave no active administrator is skipped and recorded.
- **Several directories linked to one user:** each sign-in applies the mapping of the directory used.
- **Failures:** if the groups cannot be read, or the role cannot be applied, the sign-in is refused rather than signing in with a role the directory no longer grants.

## Multi-factor authentication

Better Auth's two-factor plugin decides when to ask for the second factor in an after hook. Its matcher lists the password endpoints only (`/sign-in/email`, `/sign-in/username`, `/sign-in/phone-number`). The directory endpoint registers that same hook for its own path.

- **A user with MFA** gets the same challenge, cookie and attempt limits after a directory sign-in. No session exists until the code is checked.
- **Fail closed:** if a Better Auth release no longer has that hook, directory sign-in is refused for every user with MFA instead of skipping the second factor. The server logs an error.
- **The MFA policy** counts a directory password as a password. A user linked to an enabled directory is covered like an account with a local password, and has to set up MFA when the policy says so.
- **Setting up MFA without a local password:** turning MFA on or off, and new backup codes, ask for the account password. An account without a local one confirms with its directory password instead. The entry is found again by its unique id and checked like a sign-in, so the user filter still applies. These checks use the same rate limits. An account with neither kind of password still cannot set up MFA.

## Enforced SSO

Directory sign-in checks a password, so **enforced SSO refuses it by default**, like password sign-in. The refusal happens before the directory is contacted. Break-glass accounts keep their local password; they get no exception for directory sign-in.

- **Allow while SSO is enforced** (per directory, off by default) keeps a directory open under enforcement. Turn it on only when the directory is held to the same standard as your identity provider. Its users then also pass the second-factor step under enforcement.
- **Local passwords stay refused:** a user linked to such a directory still cannot use a local password unless they are a break-glass account.
- **The login page** offers directories open under enforcement in the **Sign in with** list behind **Sign in with a password**, next to the break-glass account. Without a break-glass account, the form sits behind **Sign in with** the directory's name (or **Sign in with a directory** when several are open).
- **Enforced SSO still needs an OAuth/OIDC provider** to be turned on. Directories do not count as one.

## Login page

When at least one directory is enabled (and, under enforced SSO, open), the password form gets a **Sign in with** choice. The first directory is selected, and the Ingressi account is the last option. Without directories, the login page is unchanged.

## Setup

1. Open **Sign-in and directories → LDAP directories** and choose **Add directory**.
2. Pick **Active Directory** or **OpenLDAP** under **Server type** to fill in the filters and attributes, then enter the URL, the service account and the search base.
3. Save, then use **Test the connection** (connect, service bind, search base) and **Test a sign-in**.
4. Turn on account creation or linking, and add group mappings if the directory should decide roles.

**Test a sign-in** checks a username and password and shows:

- the entry, its groups and the role the mapping gives;
- what a sign-in would do with the local account: sign in to the linked account, link one, create one, or refuse it and why.

It signs nobody in and changes nothing. Unlike sign-in, it tells the administrator why a check failed. It counts towards the sign-in limits for that username.

### Active Directory

```json
{
  "name": "Corp AD",
  "url": "ldaps://dc01.example.com:636",
  "caCertificate": "-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----",
  "bindDn": "CN=svc-ingressi,OU=Service Accounts,DC=example,DC=com",
  "bindPassword": "service-account-password",
  "userSearchBase": "OU=Staff,DC=example,DC=com",
  "userSearchFilter": "(&(objectClass=user)(objectCategory=person)(sAMAccountName={username})(!(userAccountControl:1.2.840.113556.1.4.803:=2)))",
  "usernameAttribute": "sAMAccountName",
  "emailAttribute": "mail",
  "displayNameAttribute": "displayName",
  "uniqueIdAttribute": "objectGUID",
  "groupMode": "member_of",
  "nestedGroups": true,
  "groupSearchBase": "OU=Groups,DC=example,DC=com",
  "groupRoleMappings": [
    { "group": "CN=Ingressi Admins,OU=Groups,DC=example,DC=com", "role": "admin" },
    { "group": "CN=Ingressi Viewers,OU=Groups,DC=example,DC=com", "role": "viewer" }
  ],
  "defaultRole": "viewer",
  "requiredGroup": "CN=Ingressi Users,OU=Groups,DC=example,DC=com",
  "provisionUsers": true
}
```

- **Disabled accounts:** the `userAccountControl` clause leaves them out of the search.
- **Nested groups:** without `nestedGroups`, only direct memberships count. `memberOf` does not list the primary group (usually Domain Users).
- **Users in more than 1500 groups:** Active Directory returns `memberOf` in ranges, which are not read. Use `nestedGroups` for such users.

### OpenLDAP

```json
{
  "name": "OpenLDAP",
  "url": "ldap://ldap.example.com:389",
  "startTls": true,
  "bindDn": "cn=ingressi,ou=services,dc=example,dc=com",
  "bindPassword": "service-account-password",
  "userSearchBase": "ou=people,dc=example,dc=com",
  "userSearchFilter": "(&(objectClass=inetOrgPerson)(uid={username}))",
  "usernameAttribute": "uid",
  "emailAttribute": "mail",
  "displayNameAttribute": "cn",
  "uniqueIdAttribute": "entryUUID",
  "groupMode": "search",
  "groupSearchBase": "ou=groups,dc=example,dc=com",
  "groupSearchFilter": "(&(objectClass=groupOfNames)(member={dn}))",
  "groupRoleMappings": [{ "group": "cn=ingressi-admins,ou=groups,dc=example,dc=com", "role": "admin" }],
  "provisionUsers": true
}
```

- **memberOf overlay:** with it, `"groupMode": "member_of"` works too.
- **posixGroup:** use `(&(objectClass=posixGroup)(memberUid={username}))`.
- **Service account:** it needs read access to the user and group entries, including the operational attribute `entryUUID`.

## REST API

All endpoints take a Bearer token or a session. Reading needs `ldap:read`. Changing and testing need `ldap:write`, which is administrator-level: only administrators can grant it in a custom role.

| Method and path | What |
| --- | --- |
| `GET /api/v1/ldap-directories` | List directories |
| `POST /api/v1/ldap-directories` | Create a directory (`201`; `409` when the name is taken) |
| `GET /api/v1/ldap-directories/{id}` | One directory |
| `PUT /api/v1/ldap-directories/{id}` | Change a directory; fields left out keep their values |
| `DELETE /api/v1/ldap-directories/{id}` | Delete a directory and its account links (`204`) |
| `POST /api/v1/ldap-directories/{id}/test` | Test the connection |
| `POST /api/v1/ldap-directories/{id}/test-sign-in` | Test a sign-in: `{"username", "password"}` |

- **Secrets:** `bindPassword` is stored encrypted with `SESSION_SECRET` and never returned; responses carry `hasBindPassword`. An omitted or empty `bindPassword` keeps the stored one. Changing the `url` requires entering it again, so a stored password is never sent to a server it was not entered for.
- **Warnings:** responses carry `warnings`, for example for an unencrypted connection.
- **Health:** responses carry `health`, the last periodic connection check (see [Health checks](#health-checks)).
- **Validation:** unknown fields and invalid settings answer `400`. The user filter must use `{username}` where a value goes.
- **Full schema:** the OpenAPI document at `/api/v1/openapi.json`, tag "LDAP Directories".

Signing in:

```bash
curl -X POST https://proxy.example.com/api/auth/sign-in/ldap \
  -H "Content-Type: application/json" -H "Origin: https://proxy.example.com" \
  -d '{"directoryId": 1, "username": "jdoe", "password": "..."}'
```

The answer is `200` with a session cookie, `200 {"twoFactorRedirect": true}` for an account with MFA, `401`, `429` or `503`.

## Health checks

Every 5 minutes each **enabled** directory is checked the way **Test the connection** does it: connect with the configured TLS, bind as the service account and read the user search base. Each step uses the directory's own connect and operation timeouts, and the whole check gives up after the connect timeout plus twice the operation timeout plus 5 seconds.

- **What is kept** (`health` on each directory in the REST API): `status` (`ok` or `failing`), `checkedAt`, `lastSuccessAt`, `lastFailureAt`, `failingSince`, `lastError` and `consecutiveFailures`. `lastError` is the step that failed and why, for example `Service account bind: invalid credentials (LDAP result 49)`; it never contains a password.
- **Starts over** when the connection settings, the service account or the user search base change (`health` is `null` until the next check), and is deleted with the directory.
- **Test the connection** on an enabled directory records its result as the health too, so fixing a directory and testing it clears the warning at once.
- **Where it shows:** the LDAP directories page has a Health column, and **Sign-in and directories** shows a failing directory with when it started failing, the failed checks in a row and the last error, with **Test the connection** next to it (`documentation/sign-in-and-directories.md`).
- **The overview** lists a failing directory under "Needs attention" (`getIdentityHealth()` in `src/lib/identity-health.ts`); after 3 failed checks in a row it is shown as critical.
- **Audit:** only changes of state are recorded, `ldap_directory_unavailable` when a directory starts failing and `ldap_directory_recovered` when it works again, with no user.
- Disabled directories are not checked.

## Deleting a directory

- **Account links** of the directory are deleted with it, in the same transaction.
- **Users are kept.** Those without a local password or another sign-in method can no longer sign in until an administrator gives them one or deletes them.
- **Existing sessions** stay valid until they expire. Disabling a directory has the same effect on sign-in, and keeps the links.

## Multiple instances

Directories are per dashboard and are **not synchronized** to sync slaves, like users and accounts, which they sign in to. Configure a directory on each instance whose dashboard people sign in to.

## Audit events

| Action | When |
| --- | --- |
| `ldap_directory_created`, `ldap_directory_updated`, `ldap_directory_deleted` | A directory was created, changed or deleted. Never holds the service account password. |
| `ldap_directory_tested`, `ldap_directory_sign_in_tested` | An administrator tested the connection or a sign-in (the username, never the password). |
| `ldap_directory_unavailable`, `ldap_directory_recovered` | The periodic health check found a directory failing, or working again (no user). |
| `ldap_user_provisioned` | A first sign-in created an account. |
| `ldap_account_linked` | A first sign-in linked an existing account. |
| `ldap_role_changed` | The group mapping changed a user's role. |
| `ldap_role_change_skipped` | The mapping would have left no active administrator, or the change failed. |
| `ldap_sign_in_refused` | The directory accepted the password but the sign-in was refused, with the reason. Wrong passwords are not recorded. |
| `login_success` | "User signed in through an LDAP directory", once the sign-in (and its second factor) completes. |
| `sso_enforced_sign_in_refused` | A directory sign-in reached the session step while enforcement refused it. |

## Security notes

- **Input never shapes a query.** The typed username only fills `{username}` in the administrator's filter, escaped per RFC 4515, and only where a value goes (checked when the filter is saved). The DN that is bound is the one the directory returned for the single matching entry.
- **No unauthenticated binds.** Empty and blank passwords are refused before any connection; the connection layer refuses them again.
- **No enumeration.** Unknown users, wrong passwords and every refusal get the same answer, and unknown users bind like wrong passwords.
- **TLS by default.** Certificates and names are always verified; clear text needs an explicit, warned switch; a dropped connection is never re-opened without TLS.
- **Roles only from explicit mappings.** No attribute of the entry grants a role. The default role is never `admin`. The primary admin and break-glass accounts are never linked or changed, and an e-mail match never links an administrator or a custom-role user.
- **Stable links.** Accounts are linked by the entry's unique id in a per-directory namespace, never by DN or username.
- **Same session rules as every sign-in.** Disabled accounts, MFA, the MFA policy and enforced SSO apply; directory management is administrator-level (`ldap:write`).
- **Secrets.** The service account password is encrypted at rest, re-encrypted on a `SESSION_SECRET` rotation, never returned, and never sent to a new URL without being entered again. Passwords are never logged or written to the audit log.

## Limits

- **Authentication:** simple bind only. No SASL, Kerberos or client certificates.
- **Group mappings:** map to the built-in roles only, not to custom roles.
- **Large groups:** a user in more than 1000 groups cannot sign in (fail closed). Active Directory's ranged `memberOf` values are not read.
- **Filter escapes:** escapes such as `\c3\a9` for non-ASCII characters in a filter template are not supported. Write the characters themselves.
- **Response sizes:** the server is trusted not to send oversized responses. Searches ask for little (two users, the configured attributes, group DNs only), but individual values are only checked after they arrive.
