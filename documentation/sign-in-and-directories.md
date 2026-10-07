# Sign-in and directories

**Sign-in and directories** (`/sign-in`, permission `sso:read`) shows how people sign in to the dashboard and where their accounts come from, on one page. It reads stored state only: it never connects to a provider or directory.

## Enforced single sign-on

The first card says whether single sign-on is required, who turned it on and when, and lists the break-glass accounts with their second factor, last sign-in and whether they can still sign in with a password. **Correct passwords refused, 7 days** counts the `sso_enforced_sign_in_refused` events of the audit log; **View in the audit log** opens them.

**What the login page offers now** previews the buttons people see: each enabled OpenID Connect and SAML provider, each LDAP directory open for sign-in (marked unavailable while it fails its connection check), and the password form, which only break-glass accounts can use while SSO is enforced. Enforced without a break-glass account that can sign in, the login page has no password or passkey sign-in. For when the identity provider is down, see [Recovery](../ee/docs/sso-enforcement.md#recovery).

**Turn off** (`sso:write`) turns enforcement off after a confirmation. **Change break-glass accounts** opens the Single sign-on page. See `ee/docs/sso-enforcement.md`.

## Where people sign in from

One card per source, each with the accounts that come from it, its group-to-role mappings, its last activity and **Configure**:

- **OpenID Connect and OAuth providers** (from the OAuth providers page): issuer, scopes, auto-link, and whether new accounts or roles come from the provider (`AUTH_ALLOW_OAUTH_REGISTRATION`, `AUTH_ALLOW_OAUTH_ROLE_FROM_CLAIMS`).
- **SAML providers:** who may sign in, how accounts are linked, and the IdP signing certificate that expires first.
- **LDAP directories** (`ldap:read`): the connection check, every 5 minutes for an enabled directory. A failing directory shows when it started failing, how many checks in a row failed and the last error, for example `Service account bind: invalid credentials (LDAP result 49)`. **Test the connection** (`ldap:write`) connects, binds as the service account and reads the user search base, showing each step; for an enabled directory the result also updates its health.
- **SCIM provisioning** (`scim:read`): whether it accepts requests, the users and groups it manages, its mappings, the newest change a SCIM request made and its tokens (prefix only).

Last activity is the newest dashboard sign-in through that provider or directory, whichever account made it, recorded when the sign-in completes (a sign-in that needs a second factor counts once that is given). An account deleted since shows as **Deleted account**. Sign-ins made before this was recorded are not counted.

These settings are per dashboard; synced instances do not receive them.

## REST API

`GET /api/v1/sign-in/overview` (`sso:read`) returns the same data: `enforcement`, `loginPage`, `oidc`, `saml`, `ldap` (null without `ldap:read`) and `scim` (null without `scim:read`). It never returns a client secret, bind password, key or token value.
