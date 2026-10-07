# Forward auth portal

Ingressi can put a sign-in page in front of a proxy host: visitors sign in with their Ingressi account (a password or OAuth) before the request reaches the app, and a host's excluded paths skip it. Someone who signed in to the dashboard through an identity provider (OIDC, SAML or an LDAP directory) is signed in without being asked again, so single sign-on across the apps they are granted comes from that provider. A dashboard session from a password or a passkey is not reused: the visitor signs in at the portal. The portal passes the user's identity to the app in [identity headers](#identity-headers). It is off on every host until you turn it on for that host. An external forward-auth server such as Authentik or Authelia can be used instead.

## How it works

1. Enable **Forward Auth** on a proxy host and choose which users or groups may access it.
2. Unauthenticated visitors are redirected to the Ingressi login portal.
3. After login, Ingressi issues a session cookie and redirects back to the protected app.
4. Caddy's `forward_auth` directive validates every subsequent request against Ingressi.

## Groups

Create groups on the **Groups** page to organise users ([users-and-groups.md](users-and-groups.md#groups)). When you grant a group access to a proxy host, all current and future members of that group gain access automatically.

## Per-host access control

Each forward-auth-protected host has its own access list of allowed users and/or groups. Access is separate from the user's role: administrators need to be granted it too.

## Identity headers

On each request it lets through, the portal passes the user to the upstream in these headers, and client-sent copies of them are removed:

- `X-Ingressi-User-Id`: the account's id. It does not change, so it is the one to key users on.
- `X-Ingressi-User`: the sign-in username, or the email address for an account without one. Ingressi keeps it from belonging to two accounts, but an administrator can change it.
- `X-Ingressi-Email`: the email address.
- `X-Ingressi-Groups`: the user's group names, comma-separated.

The same values are also sent as `X-CPM-User-Id`, `X-CPM-User`, `X-CPM-Email` and `X-CPM-Groups`, the names from before the rename. They are deprecated.

## Non-standard ports

Protected sites are expected on the default ports 80/443. If browsers reach them on another port (e.g. Caddy published as `8443:443`), list it in `FORWARD_AUTH_ALLOWED_PORTS` (comma-separated) and recreate the web container (`docker compose up -d`; with PostgreSQL replicas, set it on every replica). Logins, redirects and sessions on any other non-default port are refused, and the web container logs a warning naming the port.

## Login rate limits

Portal logins use `LOGIN_MAX_ATTEMPTS`, `LOGIN_WINDOW_MS` and `LOGIN_BLOCK_MS`:

- `LOGIN_MAX_ATTEMPTS` failures from one client block that client, and `LOGIN_MAX_ATTEMPTS` failures from one client against one account block that client for that account, for `LOGIN_BLOCK_MS`. IPv6 clients are counted per /64 prefix.
- Failures against one account from all clients combined are counted over one hour (or `LOGIN_WINDOW_MS` if longer) from the first failure. Reaching the ceiling blocks the account for `LOGIN_BLOCK_MS`. The ceiling is `LOGIN_MAX_ATTEMPTS` × (⌈window ÷ min(`LOGIN_WINDOW_MS`, `LOGIN_BLOCK_MS`)⌉ + 1), and at least 10 × `LOGIN_MAX_ATTEMPTS`: 65 with the defaults, more than one client can reach under its own limits. A successful login clears the client's own counters but not this one.
- One client cannot lock an account, but a few together can: with the defaults each can make about 48 failures per hour (4 per 5-minute window) without being blocked, so e.g. a dual-stack host (IPv4 plus IPv6) or two /64s can reach the account ceiling. This is inherent to a per-account limit.
- Attempts still being checked count towards every limit; extra concurrent attempts get `429`.

The client address is the rightmost `X-Forwarded-For` entry, which is the real client when clients connect to Caddy directly (Caddy is the outermost proxy in front of Ingressi). When port 3000 is reached directly, clients control that header and the per-IP limits are only best effort, so expose the portal (`BASE_URL`) through Caddy or another proxy that overwrites `X-Forwarded-For` rather than publishing port 3000 to untrusted networks (`docker-compose.yml` publishes it on all interfaces as `3000:3000`; change that to `127.0.0.1:3000:3000`, or block it in the `DOCKER-USER` chain or an external firewall; ufw and other host INPUT rules do not apply to Docker-published ports). Behind a CDN, the rightmost entry is the CDN edge: set `TRUSTED_CLIENT_IP_HEADER` (e.g. `cf-connecting-ip`), but only if the origin accepts connections from the CDN alone, since clients could otherwise forge the header. Leave it unset when Caddy is the outermost proxy, because Caddy passes `X-Real-IP` and `CF-Connecting-IP` through unchanged. The same client address is used for the rate limit of the slave sync endpoint.
