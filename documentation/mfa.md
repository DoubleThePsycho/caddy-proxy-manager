# Multi-factor authentication

Multi-factor authentication (MFA) adds a second step to **dashboard sign-in with a password**: a 6-digit code from an authenticator app (TOTP), or a one-time backup code. A **passkey** counts as MFA too: it checks your device and your PIN or biometrics, and signs you in without the password.

It is built on Better Auth's two-factor and passkey plugins. Ingressi adds its own checks around them: enforced SSO, account status, the MFA policy, audit records and the limits described below.

An account has MFA on when it has an authenticator app, at least one passkey, or both.

## What it covers

- **Dashboard password sign-in only.** Both Better Auth password endpoints are covered: `/api/auth/sign-in/username` (the login page) and `/api/auth/sign-in/email`. For an account with MFA, a correct password does not create a session. The answer is `{"twoFactorRedirect": true}` together with a short-lived challenge cookie, and the session is created only after a valid code.
- **Directory sign-in** (LDAP / Active Directory, `/api/auth/sign-in/ldap`) checks a password too and gets the same second step. See `ee/docs/ldap.md`.
- **Passkey sign-in** (`/api/auth/passkey/verify-authentication`) is a sign-in of its own: the passkey proves both factors, so it asks for nothing else. See [Passkeys](#passkeys).
- **Not covered:**
  - **OAuth/OIDC and SAML sign-in.** The identity provider is responsible for MFA, so sign-ins through it are never asked for a local code, even by an account that has MFA turned on (it applies to that account's password sign-in). SAML sign-in (`ee/docs/sso-saml.md`) does not ask the identity provider for a particular authentication method either; require MFA there.
  - **The forward-auth portal** (`/portal`, where end users of protected applications sign in). It is unchanged and does not ask for a second factor. A dashboard session from a password and a second factor does not sign anyone in to protected apps: the portal asks for the username and password. Sign-ins through an identity provider are reused, and the second factor is then the provider's.
  - **API tokens.** They are separate credentials and keep working. New tokens can only be created from an interactive session, which means after the second step.

## Setting it up

Open **Profile → Multi-factor authentication → Set up authenticator app**, then:

1. Confirm your password.
2. Scan the QR code with an authenticator app (a password manager, Google Authenticator, Microsoft Authenticator, Aegis, and so on), or type in the key shown under it. The QR code is drawn in your browser.
3. Enter the 6-digit code the app shows. MFA is on from this point.
4. Save the 10 backup codes, for example in a password manager. Each code works once, and they are not shown again.

Only accounts with a password can set up MFA. An account that signs in only through an identity provider gets a short explanation instead. An account that signs in only through an LDAP directory confirms with its directory password wherever a password is asked.

### Afterwards

Profile shows how many backup codes are left. From there you can:

- **Generate new backup codes.** This needs your password, and the old codes stop working.
- **Turn MFA off.** This also needs your password. It is refused while the MFA policy requires MFA for your account.

The authenticator secret and the backup codes are never shown or returned again after setup. Use **Turn off** and set MFA up again to move to a new device.

## Signing in

After your username and password, the login page asks for the code from your authenticator app. Choose **Use a backup code** if you do not have the app, or **Use a passkey** if you have one.

If your only second factor is a passkey, the password step does not sign you in: the login page asks for the passkey instead (`{"twoFactorRedirect": true, "twoFactorMethods": ["passkey"]}`, and no session). You can also skip the password and choose **Sign in with a passkey** directly; the login page offers it once any account has a passkey.

- **Codes:** a code from the step before or after the current 30-second step is also accepted, to allow for clock drift. Spaces in the code are ignored.
- **"Trust this device" is not offered.** Every password sign-in asks for the second factor.

### Limits on second-factor attempts

- **Per sign-in:** a challenge is valid for 5 minutes and allows 5 wrong codes. After that the person has to enter the password again.
- **Per account:** 10 consecutive failed codes, across sign-ins and for both authenticator and backup codes, lock the second step for 15 minutes. A successful code resets the count, and so does an administrator's reset.
- **Per client:** Better Auth allows 3 requests per 10 seconds on `/api/auth/two-factor/*`, unless `AUTH_RATE_LIMIT_ENABLED=false`.
- **Replayed codes:** an authenticator code that already completed a sign-in is refused like a wrong one for as long as it would still be valid.
- **Messages and audit:** error messages do not say why a code was refused. Every failed attempt is recorded in the audit log.

## Passkeys

A passkey is a WebAuthn credential kept by your device, password manager or security key (Touch ID, Windows Hello, Android, 1Password, a YubiKey and so on).

### Adding one

Open **Profile → Sign-in security → Add a passkey**, give it a name, confirm your password, and follow your browser's prompt.

- **Who can:** only accounts with a local password. A passkey replaces the password and its code, so accounts that sign in through an identity provider or an LDAP directory keep signing in there, and the provider or the directory keeps deciding who gets in.
- **While SSO is enforced:** only break-glass accounts can add one.
- **Freshness:** Better Auth also asks for a session less than a day old. Sign out and in again if it refuses.
- **At most 10 passkeys** per account.
- **Accounts the policy has sent to the setup page** can choose **Use a passkey instead** there.

### What is checked

- **Relying party:** the RP ID is the host name of `BASE_URL`, and only the origin of `BASE_URL` is accepted. A passkey made for another host or origin does not work here. If you change `BASE_URL` to another host, existing passkeys stop working; add new ones.
- **User verification:** the passkey must ask for your PIN or biometrics, at registration and at every sign-in. The server refuses a passkey that only proves possession of the device. That is what makes it a second factor.
- **Discoverable credentials:** passkeys are stored on the authenticator with your sign-in username, so the login page needs no username.
- **No attestation:** Ingressi does not ask the authenticator who made it. The model name is shown when the authenticator reports a known one.
- **Account status and enforced SSO:** a passkey sign-in creates its session through the same checks as every other sign-in. A disabled account gets no session, and while SSO is enforced only break-glass accounts can sign in with a passkey. A refusal answers `401 Authentication failed`, like a passkey that did not verify, and enforcement records `sso_enforced_sign_in_refused`.

### Managing them

Profile lists your passkeys with when they were added and last used. **Rename** and **Remove** work on your own passkeys only. The last second factor of an account the MFA policy covers cannot be removed (`400`): add an authenticator app or another passkey first. Removing a passkey here does not remove it from your device; remove it there too.

## Policy

Administrators set the policy on the **Users** page, or with `PUT /api/v1/mfa/policy`.

| Policy (`scope`) | Who must use MFA |
| --- | --- |
| Not required (`off`) | Nobody. Anyone with a password may still set it up. |
| Required for administrators (`admins`) | Administrators, and users with a custom role, who can sign in with a password. |
| Required for everyone who signs in with a password (`password_users`) | Every account that can sign in with a password. |

### Which accounts are covered

- **What satisfies it:** an authenticator app or a passkey.
- **Accounts that can sign in with a password:** an account is covered only if it has a password. This includes accounts that usually sign in through an identity provider but also have a password, because that password is still a way in. A directory password counts too: an account linked to an enabled LDAP directory is covered.
- **Enforced SSO:** while it is on, only break-glass accounts keep password sign-in, so only they are covered, together with accounts of a directory that stays open under enforcement.

### The grace period

- **When it starts:** whenever the policy's scope changes. The default is 7 days and the maximum is 90.
- **When it ends:** changing only the number of days moves the end of the current period.
- **During the grace period:** covered accounts without MFA are sent to the setup page after they sign in. They can choose **Remind me later**, and every dashboard page shows a banner with the deadline.
- **After the grace period:**
  - Every page of the dashboard sends such an account to `/mfa-setup`, and its sessions get `403` from `/api/v1`, until it sets up MFA. Signing out still works.
  - Accounts that become covered after the deadline, such as new accounts or newly promoted administrators, set up MFA at their first sign-in.
- **The risk:** whoever signs in with the password can complete the setup. Keep the grace period short and check the **pending** list (`GET /api/v1/mfa/policy`) so that people set up MFA themselves.

The policy is per dashboard and is **not synchronized** to sync slaves. Users are not synchronized either.

## Recovery

| Situation | What to do |
| --- | --- |
| Lost the authenticator app, still have backup codes | Sign in with a backup code, then turn MFA off and set it up again on Profile. |
| Lost the authenticator app, still have a passkey | Sign in with the passkey, then turn the authenticator app off on Profile and set it up again. |
| Lost a passkey | Sign in another way and remove it on Profile. |
| No second factor left | An administrator resets your MFA on **Users and groups** (**Reset MFA** in your row menu or your panel) or with `DELETE /api/v1/users/{id}/mfa`. This removes the authenticator app, the backup codes and every passkey. You then sign in with your password alone and can set MFA up again. Your sessions are kept. Administrators cannot reset their own MFA this way; they turn it off on Profile. |
| The primary admin is locked out | Change `ADMIN_PASSWORD` (or `ADMIN_USERNAME`) in `.env` and recreate the web container: `docker compose up -d --force-recreate web`. See below. |
| Locked for 15 minutes after failed codes | Wait, or ask an administrator to reset your MFA. |

### Environment reset of the primary admin

- **What it clears:** changing `ADMIN_USERNAME` or `ADMIN_PASSWORD` is the documented account recovery. Besides resetting the password and reactivating the primary admin, it **turns off that account's MFA**, passkeys included. The server logs this line and records `mfa_reset` in the audit log:

  ```
  Turned off multi-factor authentication for <username> because the environment credentials changed (account recovery). Set it up again from Profile.
  ```

- **When it applies:** only when the environment credentials change. Restarting with unchanged ones keeps MFA.
- **Why this is safe:** anyone who can change the web container's environment already controls the installation.
- **Under enforced SSO:** the reset does not bypass enforcement (see the SSO enforcement documentation).

### A corrupted policy setting

- **What happens:** a policy row that cannot be read fails closed, meaning MFA is required for every account with a password, with no grace period.
- **How to fix it:** remove the policy from the host. No restart is needed, also with several replicas: the policy is read at every sign-in. The tool works on SQLite and on PostgreSQL, on the database the web container's `DATABASE_URL` names:

  ```bash
  docker compose exec web bun db-tools/break-glass.js remove-mfa-policy
  ```

  Without a policy nobody is required to use MFA; set it again on the **Users** page once you can sign in. The change bypasses the application, so it is not in the audit log.

## Enforced SSO and break-glass accounts

- **Break-glass accounts:** a break-glass account with MFA signs in with its password and then its second factor, or with a passkey. The session is created only after the code or the passkey.
- **Passkeys of other accounts** are refused while enforcement is on: a passkey sign-in is not an identity-provider sign-in. They work again when enforcement is turned off.
- **Other accounts:** they are refused at the password step exactly as before, so no challenge is issued and the refusal does not reveal whether the password was right.
- **Turning MFA on or off** replaces the caller's current session. That is not a new sign-in, so it works while SSO is enforced, as existing sessions do.

## What is stored

| Value | Where | Protection |
| --- | --- | --- |
| Authenticator (TOTP) secret | `two_factors.secret` | Encrypted by Better Auth (XChaCha20-Poly1305) with a key derived from `SESSION_SECRET` |
| Unused backup codes | `two_factors.backupCodes` | Encrypted with Ingressi's `encryptSecret` (AES-256-GCM, key from `SESSION_SECRET`) |
| MFA on/off | `users.twoFactorEnabled` | — |
| Failed attempts and the lock | `two_factors.failedVerificationCount`, `lockedUntil` | — |
| Passkeys | `passkeys`: the public key, the credential id, the signature counter, the name and when it was added and last used | A public key is not a secret; no private key ever reaches the server |

- **Never returned:** neither secret leaves the server after setup. The REST API and the dashboard report only whether MFA is on and how many backup codes are left. Better Auth's `/two-factor/get-totp-uri`, `/two-factor/send-otp` and `/two-factor/verify-otp` endpoints are turned off.
- **Rotating `SESSION_SECRET`:** both values are re-encrypted at startup when the old secret is in `SESSION_SECRET_PREVIOUS`, like every other stored secret.
- **When neither key opens a secret:** the startup log names the user. Reset that user's MFA. A user whose authenticator secret cannot be read can still sign in with a backup code.
- **Deleting a user** also deletes their MFA data and passkeys.

## REST API

### Administrators and users (`/api/v1`)

All of these take a Bearer token or a session.

| Method and path | Who | What |
| --- | --- | --- |
| `GET /api/v1/mfa` | Any user | The caller's MFA state |
| `GET /api/v1/users/{id}/mfa` | Administrators, or the user themself | A user's MFA state |
| `DELETE /api/v1/users/{id}/mfa` | Administrators | Reset another user's MFA. `400` for your own account. Audited as `mfa_reset`. |
| `GET /api/v1/mfa/policy` | Administrators | The policy, the deadline, and the covered accounts without MFA |
| `PUT /api/v1/mfa/policy` | Administrators | Change the policy. Audited as `mfa_policy_updated`. |

MFA state (the same shape for both `GET` endpoints that return it):

```json
{ "enabled": true, "authenticatorApp": true, "passkeys": 1, "backupCodesRemaining": 8, "hasPassword": true, "required": true, "gate": "none", "deadline": null }
```

`enabled` is true when the account has an authenticator app or a passkey.

`gate` is one of:

- `none`: nothing to do.
- `prompt`: set up MFA before `deadline`.
- `required`: the grace period is over; dashboard sessions can only set up MFA.

Changing the policy:

```bash
curl -X PUT https://proxy.example.com/api/v1/mfa/policy \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"scope": "admins", "graceDays": 7}'
```

- **Body:**
  - `scope` is required: `off`, `admins` or `password_users`.
  - `graceDays` is optional, a whole number from 0 to 90. Omit it to keep the current value.
- **Validation:** unknown fields are refused with `400`.

### Your own second factor (Better Auth, `/api/auth/two-factor`)

These endpoints need an **interactive session cookie** and, except to verify a code, the account password. API tokens cannot set up, read or remove a second factor.

| Endpoint | Body | What |
| --- | --- | --- |
| `POST /api/auth/two-factor/enable` | `{"password"}` | Start setup. Returns `totpURI` and `backupCodes`, once. |
| `POST /api/auth/two-factor/verify-totp` | `{"code"}` | Confirm setup, or complete a sign-in |
| `POST /api/auth/two-factor/verify-backup-code` | `{"code"}` | Complete a sign-in with a backup code |
| `POST /api/auth/two-factor/generate-backup-codes` | `{"password"}` | Replace the backup codes. Returns the new ones, once. |
| `POST /api/auth/two-factor/disable` | `{"password"}` | Turn the authenticator app off. `400 MFA_REQUIRED_BY_POLICY` while the policy requires MFA and the account has no passkey. |

### Your passkeys

| Endpoint | Body | What |
| --- | --- | --- |
| `GET /api/auth/passkey/generate-register-options` | — | Start adding a passkey (session; the account must be allowed to add one, `400 PASSKEY_NOT_ALLOWED` otherwise) |
| `POST /api/auth/passkey/verify-registration` | `{"response", "name", "password"}` | Store the passkey the browser made. `400 INVALID_PASSWORD`, `400 USER_VERIFICATION_REQUIRED` |
| `GET /api/auth/passkey/generate-authenticate-options` | — | Start a passkey sign-in |
| `POST /api/auth/passkey/verify-authentication` | `{"response"}` | Sign in with a passkey |
| `GET /api/v1/passkeys` | — | Your passkeys (never the key), and whether you can add one |
| `PATCH /api/v1/passkeys/{id}` | `{"name"}` | Rename one of yours |
| `DELETE /api/v1/passkeys/{id}` | — | Remove one of yours; `400` when it is the last second factor the policy needs |

Better Auth's own `/passkey/list-user-passkeys`, `/passkey/update-passkey` and `/passkey/delete-passkey` are turned off. The `/api/v1/passkeys` endpoints need a session or an API token without scopes.

## Audit events

| Action | When |
| --- | --- |
| `mfa_enabled` / `mfa_disabled` | A user turned MFA on or off |
| `mfa_backup_codes_regenerated` | A user replaced their backup codes |
| `mfa_backup_code_used` | A backup code completed a sign-in |
| `mfa_verification_failed` | A wrong, expired or replayed code at sign-in. `data.reason` has the Better Auth error code. |
| `mfa_reset` | An administrator reset a user's MFA, or the environment reset did it for the primary admin (`userId` null) |
| `mfa_policy_updated` | The policy changed |
| `passkey_added` / `passkey_renamed` / `passkey_removed` | A user changed their passkeys |
| `login_success` | Recorded only once a sign-in completes. With MFA, the summary is "User signed in with a second factor"; with a passkey, "User signed in with a passkey". |
