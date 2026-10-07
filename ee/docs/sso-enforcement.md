# Enforced SSO

Source: `ee/sso/` (Elastic License 2.0).

Enforced SSO turns off password sign-in to the dashboard. People sign in through an OAuth/OIDC or SAML provider instead. Optionally, a short list of **break-glass accounts** keeps its username and password, so that an administrator can still get in when the identity provider is down. Without one, the way back in during an outage is [turning enforcement off from the host](#turning-enforcement-off-from-the-host).

## What it covers

- **Dashboard sign-in only.** The forward-auth portal (`/portal`, the login page for end users of protected applications) is not affected. Portal users keep signing in as configured per host.
- **Password sign-in is refused** on every Better Auth credential endpoint: `/api/auth/sign-in/username` (the login page) and `/api/auth/sign-in/email`. Enforcement is applied when the session is created and checks the account that authenticated, so it does not matter which name or address was typed. The refusal is exactly the reply a wrong password gets (`401 Invalid username or password` or `401 Invalid email or password`) and takes as long. It does not reveal whether the password was right or which accounts are break-glass accounts.
- **Self-registration with a password is refused** (`/api/auth/sign-up/email` answers `400 EMAIL_PASSWORD_SIGN_UP_DISABLED`) before any account is created, even with `AUTH_ALLOW_SELF_REGISTRATION=true`.
- **Fail closed for new sign-in methods.** While enforcement is on, Better Auth may only create a session from the OAuth callback (`/callback/:id`), a provider-verified ID-token sign-in (`/sign-in/social`) or the SAML assertion consumer service (`/saml/acs/:providerId`, `ee/docs/sso-saml.md`), or for a break-glass account. Any other endpoint, including one a future plugin adds, is refused.
- **OAuth/OIDC sign-in, account linking, OAuth self-registration (`AUTH_ALLOW_OAUTH_REGISTRATION`) and the role-claim opt-in work as before.** So does **SAML sign-in** (`ee/docs/sso-saml.md`): it counts as single sign-on.
- **LDAP / Active Directory sign-in** (`/api/auth/sign-in/ldap`, `ee/docs/ldap.md`) checks a password, so it is refused too, before the directory is contacted. A directory stays open only when its **Allow while SSO is enforced** setting is on (off by default). Break-glass accounts get no exception for directory sign-in; they use their local password.
- **Passkeys** (`/api/auth/passkey/verify-authentication`) are not an identity-provider sign-in either: only break-glass accounts can sign in with a passkey, or add one, while enforcement is on. A refused passkey answers `401 Authentication failed`. See `documentation/mfa.md`.
- **Multi-factor authentication:** a break-glass account with MFA also has to pass its second factor after the password. Turning MFA on or off replaces the caller's existing session with a new one for the same account; this is allowed for every account, because it is not a new sign-in. See `documentation/mfa.md`.
- **Not covered:**
  - API tokens keep working. They are separate credentials, and new ones can only be created from an interactive session.
  - Sessions that already exist when enforcement is turned on stay valid until they expire (at most 7 days). Disable an account to end its sessions immediately.
- Each refused correct password is recorded in the audit log as `sso_enforced_sign_in_refused`. Wrong passwords are not recorded.

## Setup

1. Configure and enable at least one OAuth/OIDC provider (the **OAuth providers** page) or SAML provider (**Sign-in and directories → SAML**). Check that administrators can sign in with it, and link existing accounts from **Profile** if needed.
2. Optionally, choose break-glass accounts: accounts that can sign in on the login page with a username and password. For a way in during an outage of the identity provider, include an **active administrator** and store its password offline, for example in a safe or a password manager outside the identity provider.
3. Open **Sign-in and directories → Single sign-on**, select the break-glass accounts (or none), turn on **Require single sign-on for dashboard sign-in** and save.

Turning enforcement on is refused with `400` when no OAuth/OIDC or SAML provider is enabled. While it is on without a break-glass administrator, the Single sign-on and Sign-in and directories pages show the command that turns it off from the host.

### Login page

With enforcement on and at least one provider enabled, the login page shows single sign-on first, one button per provider naming the host it sends the browser to. The password form is collapsed behind **Sign in with a password** ("Break-glass accounts only"), with a note that every sign-in is recorded. If every provider is disabled later, the password form is shown directly, because break-glass accounts are then the only way in.

Without a break-glass account that can sign in (one that exists, is active and has a password), the login page offers no password sign-in and no passkey sign-in: only the providers, and LDAP directories that stay open under enforcement (behind **Sign in with** the directory's name).

## Lockout guards

Break-glass accounts are optional, so the setting can be saved with none. While enforcement is on with at least one break-glass administrator (an active administrator that can sign in with a password), demoting, disabling or deleting the last one is refused with `400`, from the Users page, through `/api/v1/users/{id}`, SCIM or an access review. To go without one, remove it from the break-glass accounts on the Single sign-on page first. The check and the change run in one database transaction.

Break-glass accounts are stored by user id, so renaming an account (including an `ADMIN_USERNAME` change of the primary admin) keeps it break-glass. A deleted account is removed from the list, so a later account cannot inherit it. The API and the page show and accept usernames.

## REST API

Both operations require an administrator (Bearer token or session).

### `GET /api/v1/sso/enforcement`

```json
{
  "enabled": true,
  "breakGlassUsernames": ["breakglass"],
  "breakGlassAccounts": [
    { "id": 4, "username": "breakglass", "name": "Break glass", "email": "ops@example.com",
      "role": "admin", "status": "active", "passwordSignIn": true, "validAdmin": true }
  ],
  "ssoProviders": [{ "id": "a1b2", "name": "Keycloak", "kind": "oidc" }, { "id": "saml:3", "name": "Entra ID", "kind": "saml" }],
  "warnings": []
}
```

`warnings` lists problems with the setting, such as a break-glass account that lost its password or enforcement with no enabled provider. `validAdmin` marks an active administrator that can sign in with a password; with none while `enabled`, the way back in during an outage is turning enforcement off from the host.

### `PUT /api/v1/sso/enforcement`

```bash
curl -X PUT https://proxy.example.com/api/v1/sso/enforcement \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"enabled": true, "breakGlassUsernames": ["breakglass"]}'
```

- **Body:**
  - `enabled` (boolean) is required.
  - `breakGlassUsernames` takes up to 20 sign-in usernames, matched case-insensitively. Omit it to keep the current list.
- **Validation:** every name must belong to an account that can sign in with a password. An empty list is accepted, also with `"enabled": true`.
- **Responses:**
  - `200` returns the same body as `GET`.
  - `400` for validation failures, and when turning enforcement on (or changing it while on) with no enabled OAuth/OIDC or SAML provider.
  - `403` when the caller is not an administrator.
- **Audit:** every change is recorded as `sso_enforcement_updated`.

## Recovery

### The identity provider is down

With a break-glass account: on the login page, choose **Sign in with a password** and sign in with it, or use its passkey. Without one, [turn enforcement off from the host](#turning-enforcement-off-from-the-host).

### No break-glass password is available

- **The primary admin is a break-glass account:**
  1. Set a new `ADMIN_PASSWORD` (and `ADMIN_USERNAME` if needed) in `.env`.
  2. Recreate the web container with `docker compose up -d --force-recreate web`. The new environment password is applied on start, the primary admin is reactivated, and its multi-factor authentication is turned off.
  3. Sign in with **Sign in with a password**.
- **The primary admin is not a break-glass account:** the environment reset still resets its password, but **does not bypass enforcement**, and the server logs a warning saying so. This is deliberate. An automatic bypass would give every install a password sign-in that the break-glass list does not show. It would also turn a leaked `.env` into a way past SSO. Add the primary admin to the break-glass list if you want the environment reset to be your recovery path.

### Turning enforcement off from the host

Anyone with shell access to the host can turn enforcement off directly in the database, on SQLite or PostgreSQL (the database the web container's `DATABASE_URL` names):

```bash
docker compose exec web bun db-tools/break-glass.js turn-off-sso-enforcement
```

- **No restart needed:** the setting is read on every sign-in, on every replica.
- **The break-glass list is kept.**
- **Not audited:** this change bypasses the application. Note it in your change log.
- **If the stored value is corrupted:** a corrupted value is treated as "enforced, no break-glass accounts" (fail closed). The tool then deletes the setting, which turns enforcement off and empties the break-glass list, and says so.

## Multiple instances

The setting is per dashboard and is **not synchronized** to sync slaves. Users and accounts are not synchronized either, so a break-glass list would refer to accounts that do not exist on the slave. Configure enforcement on each instance whose dashboard people sign in to.

## Audit events

| Action | When |
| --- | --- |
| `sso_enforcement_updated` | The setting was changed. `data` has the new and previous `enabled` and `breakGlassUserIds`. |
| `sso_enforced_sign_in_refused` | A correct password for a non-break-glass account was refused. |
