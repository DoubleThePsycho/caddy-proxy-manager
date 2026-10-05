# Security

How to report a vulnerability, and how release images are signed: [SECURITY.md](../SECURITY.md).

## Built-in protections

- Strong passwords (12–256 characters, mixed case, numbers, special characters) for every account; in production the web container also refuses to start with a weak or example `ADMIN_PASSWORD`
- 32+ character session secrets required in production; known example values are rejected
- Stored secrets (DNS provider credentials, OAuth client secrets, certificate and CA private keys, instance sync tokens) are encrypted at rest with a key derived from `SESSION_SECRET`
- Rate limiting: dashboard sign-in through Better Auth (3 requests per 10 seconds per client address; `AUTH_RATE_LIMIT_*` for its other endpoints), and forward-auth portal logins, password changes and OAuth account linking through `LOGIN_*` (see [Login rate limits](forward-auth.md#login-rate-limits))
- Audit trail for all configuration changes
- Supports OAuth2/OIDC for SSO

## Production checklist

**Production requirements:**
- `SESSION_SECRET`: 32+ characters (`openssl rand -base64 32`), not an example value from the documentation
- `ADMIN_PASSWORD`: 12+ chars with uppercase, lowercase, numbers, and special characters, not an example password from the documentation

Development mode (`NODE_ENV=development`) allows default `admin`/`admin` credentials.

**Production setup:**
```bash
export SESSION_SECRET=$(openssl rand -base64 32)
export ADMIN_USERNAME="admin"
export ADMIN_PASSWORD="<choose-your-own: 12+ chars, upper, lower, digit, symbol>"
docker compose up -d
```

## Limitations

- Rate limit counters (forward-auth portal, directory and dashboard sign-in, password confirmations, instance sync and the other request limits) are kept in memory on SQLite, where one process serves everything, and in the database on PostgreSQL, so the limits count across replicas sharing it ([PostgreSQL](postgresql.md)). The x402 limit on refused payments (Enterprise) stays in each process's memory.
- Proxy host rate limits are counted by each Caddy instance on its own, not across instances ([Rate limiting](rate-limiting.md#several-caddy-instances)).

## Rotating SESSION_SECRET

`SESSION_SECRET` also encrypts stored secrets: DNS provider credentials, OAuth client secrets and tokens, imported certificate keys, CA private keys and instance sync tokens. To rotate it:

1. Set `SESSION_SECRET` to the new value and `SESSION_SECRET_PREVIOUS` to the old one (comma-separated if there are several).
2. Recreate the web container (`docker compose up -d`). On startup every stored secret, including a slave's synced settings, is re-encrypted with the new `SESSION_SECRET` (logged as `Re-encrypted N stored secret(s) with the current SESSION_SECRET`); `SESSION_SECRET_PREVIOUS` is never used to encrypt.
3. Remove `SESSION_SECRET_PREVIOUS` after one successful start. On an instance sync slave, wait until its master has synced to it once since the restart, and keep the master's secret while the master runs v1.12.0 or earlier (see below).

With several PostgreSQL replicas, set the same `SESSION_SECRET` and `SESSION_SECRET_PREVIOUS` on every replica and recreate them all ([several replicas](postgresql.md#several-replicas)). The start-up tasks, re-encryption included, run only on the replica that leads, each time one starts leading, so the stored secrets are re-encrypted once a replica with the new secret leads (logged as above). Remove `SESSION_SECRET_PREVIOUS` only after that, once every replica runs the new secret. Until then, a replica still on the old secret cannot read values re-encrypted with the new one.

A value that no key decrypts is left as stored and logged as `[secret] … cannot be decrypted with SESSION_SECRET or SESSION_SECRET_PREVIOUS`, followed by `N stored secret(s) listed above could not be decrypted…`; re-enter it in the UI, or set `SESSION_SECRET_PREVIOUS` to the secret it was stored with. OAuth sign-in tokens that no key decrypts are cleared instead (`Cleared N stored OAuth sign-in token(s)…`), since Ingressi does not use them and the next OAuth sign-in stores new ones. Values stored under an old example `SESSION_SECRET` are re-encrypted without any extra configuration. If a CA private key can no longer be decrypted, issuing a client certificate fails with *"The CA private key cannot be decrypted with the current SESSION_SECRET…"*; certificates already issued keep working, because only the CA certificate is needed to validate them.

With instance sync, the master and each slave can use their own `SESSION_SECRET` and rotate it independently: the master seals synced secrets (DNS provider credentials, certificate private keys) to the slave's sync key, and the slave stores them encrypted with its own `SESSION_SECRET`. The slave derives its sync key from `SESSION_SECRET`, so the key changes with it; a sync that fetched the key just before the slave restarted fails with HTTP 409, and the next one succeeds. A synced setting the master itself cannot decrypt is sent as stored, and the master logs `Instance sync: setting <path> cannot be decrypted with SESSION_SECRET or SESSION_SECRET_PREVIOUS; sending it as stored` once per value, not on every sync. A master on v1.12.0 or earlier sends DNS provider credentials encrypted with its own `SESSION_SECRET` instead, so while it does, every slave must keep the master's secret as `SESSION_SECRET` or in `SESSION_SECRET_PREVIOUS`, or applying the synced config fails (values encrypted under the old placeholder secret always decrypt). A slave on v1.12.0 or earlier receives them encrypted with the master's current `SESSION_SECRET` from any master, so it must use that same secret until it is upgraded.

The master has pinned the slave's old sync key (see [Sync key pinning](instance-sync.md#sync-key-pinning)) and accepts the new one only when the slave proves it with the key of a secret in its `SESSION_SECRET_PREVIOUS`. So on a slave, keep the old value there until the master has synced to it once since the restart: after restarting the slave, click **Sync now** on the master (`INSTANCE_SYNC_INTERVAL` defaults to `0`, so otherwise nothing syncs until the next change), then look for `Instance sync: slave "<name>" proved its new sync key <new> with the pinned key <old>; pinned the new key` in the master's log, or `instance_sync_key_rotated` in its audit log. Only then remove `SESSION_SECRET_PREVIOUS`. Removed too early, the sync fails with *"Slave sync key changed; verify the slave, then pin its new key or reset its key pin"*; put the old value back, or pin the slave's new key on the master. A slave proves at most 8 previous secrets, comma-separated entries first, so keep every secret a master may still have pinned among the first 8. The public placeholder secrets (such as `change-me-in-production`) prove nothing: after moving a slave off one, pin its new key on the master.

If the old secret may have leaked, do not rely on the automatic re-pin: anyone holding it who can answer one key request can prove a key of their own. Pin the slave's new key on the master by hand, or set `syncPublicKey` in `INSTANCE_SLAVES` (see [Sync key pinning](instance-sync.md#sync-key-pinning)); at the very least, right after rotating, click **Sync now** and check that the newly pinned key matches the one on the slave's Settings page.
