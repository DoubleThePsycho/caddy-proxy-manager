# Rate limiting

Rate limiting answers `429 Too Many Requests` to clients that send too many requests to a proxy host.

Caddy does the limiting with the [caddy-ratelimit](https://github.com/mholt/caddy-ratelimit) plugin, which the Caddy image of this release includes.

## Rules

A rule counts the requests that match its **path** and **methods**, per **key**, in a sliding **window**. Once a key has made **events** requests inside the window, further requests get `429` until the oldest one leaves the window.

| Field | Meaning |
| --- | --- |
| `path` | A Caddy path pattern: `/login`, `/api/*`, `*.php`. `*` (the default) matches every path. Matched as the client sent it, before any rewrite. |
| `methods` | `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS`, `CONNECT`, `TRACE`. None (the default) counts every method. |
| `key` | What requests are counted by (below). `client_ip` by default. |
| `header` | The header name, for the `header` key only. |
| `events` | Requests allowed per window: 1 to 1000. |
| `window` | Whole seconds, minutes or hours: `30s`, `1m`, `1h`. From 1 second to 1 hour. |

Keys:

- **`client_ip`**: the client IP as Caddy resolves it, so **Host defaults → Trusted proxies** applies. IPv6 clients are grouped by network (a `/64` by default), since one subscriber usually holds a whole `/64`.
- **`header`**: the value of a request header, such as `X-Api-Key`. Requests without the header are counted per client IP, so they never share one counter.
- **`forward_auth_user`**: the user signed in through the built-in forward auth (by user id). Requests without a signed-in user, and every request on hosts that do not use the built-in forward auth, are counted per client IP.

A host can have up to 20 rules; so can the global defaults. Two rules on the same path with different limits work together, for example 10 per second against bursts and 300 per minute overall.

## Per host and global defaults

The **Rate limiting** card in the **Security** section of the proxy host editor sets a host's rules. The **Rate limiting** page (`/rate-limiting`, under Security events in the sidebar) sets the global defaults.

| Host | Rules that apply |
| --- | --- |
| Rate limiting off (or never set) | The global defaults, when they are enabled |
| On, **Merge with global** | The global defaults and the host's rules |
| On, **Override global** | Only the host's rules. With no rules, nothing is limited on this host |

The global settings also hold:

- **Never limited**: client IPs and CIDR ranges that no rule limits, the defaults or a host's own, such as monitoring probes. `private_ranges` covers the private networks. It applies even when the default rules are off.
- **IPv6 grouping**: the prefix length IPv6 clients are grouped by (32 to 128, default 64). 128 counts every address on its own.

Each host has its own counters: a client's requests to two hosts are counted separately.

## Where it runs

On every route of a host, the client-IP and header rules run first, in this order:

1. Rate limiting (client-IP rules, then header rules)
2. WAF, geo blocking and the access list's rules
3. Path blocks, path rewrites and redirects
4. Access list members (basic auth) or the API monetization gate
5. Forward auth (built-in, Authelia or Authentik)
6. Rate limiting by signed-in user
7. The upstream

The global Blocked sources list ([access-lists.md](access-lists.md)) runs before all of them. So floods are refused before the WAF spends time inspecting them, and requests that forward auth would send to the sign-in portal are counted too: brute-force attempts against a protected site are limited. Rules keyed by the signed-in user run after forward auth, where the user is known.

Every route of the host is covered the same way: excluded and protected paths, location rules, the forward-auth callback, the Authentik outpost path and the API-bypass routes of generic forward auth. The plain-HTTP redirect to HTTPS is not limited; it serves nothing.

**API monetization.** On a monetized host both limits apply. The host's rate limit runs first, per client; the gate's per-consumer limit per minute (set on the plan) runs after it. Both answer `429` with `Retry-After`. The host limit keeps floods from reaching the gate at all.

## The response

Over the limit, Caddy answers `429 Too Many Requests` with a `Retry-After` header (seconds) and an empty body. A custom error page for status 429, on the host or in the global error pages, replaces the body and keeps the status.

## Analytics

With access logging on, the Analytics page shows how many requests were rate limited, under **Total Requests**. Only Caddy's own limiter is counted: a `429` from the upstream or from the monetization gate is not.

## REST API

The global defaults are the settings group `rate-limit`. Reading needs `settings:read`, changing needs `settings:write`. Unknown fields and values outside the limits answer `400` and change nothing.

```bash
curl -X PUT https://dash.example.com/api/v1/settings/rate-limit \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{
    "enabled": true,
    "rules": [{ "path": "/login", "methods": ["POST"], "events": 10, "window": "1m" }],
    "allowlist": ["192.0.2.10", "198.51.100.0/24"],
    "ipv6Prefix": 64
  }'
```

Proxy hosts (`/api/v1/proxy-hosts`) carry `rateLimit`: `{ "enabled", "mode", "rules" }`, or `null` when the host inherits the defaults. `enabled` defaults to `true` and `mode` to `merge`. On update, leaving `rateLimit` out keeps it; `null` removes it.

```bash
curl -X PUT https://dash.example.com/api/v1/proxy-hosts/12 \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{ "rateLimit": { "mode": "merge", "rules": [
        { "path": "/api/*", "key": "header", "header": "X-Api-Key", "events": 600, "window": "1m" }
      ] } }'
```

The schemas are `RateLimitRule`, `ProxyHostRateLimit` and `RateLimitSettings` in the API reference.

## Several Caddy instances

Each Caddy instance counts on its own. Instance sync copies the rules and the defaults to slaves, but not the counters. Behind a load balancer that spreads one client over several instances, the client can make up to the limit on each of them. Limiting shared across instances (through shared storage) is not supported.

The defaults are part of configuration export, history and backups.

## Memory

Caddy keeps one timestamp (24 bytes) per allowed request, for every client and rule, until the client's newest counted request is older than the window. A rule of 100 per minute costs about 2.4 KB per active client; 1000 per hour, about 24 KB. Prefer short windows and modest counts on busy public hosts.

## Security notes

- **Client IP behind a proxy or CDN.** Without trusted proxies, every request seems to come from the proxy, and all clients share its counter. Configure **Host defaults → Trusted proxies** first. The allowlist and the client-IP key use the same resolved IP.
- **Header keys.** A client chooses its header values, and each value gets its own counter. Use them for headers the upstream checks (API keys), together with a client-IP rule: header rules only see requests that the client-IP rules let through, which caps how many values one client can try. Headers that forward auth sets for the upstream (such as `Remote-User`) are removed from client requests before rate limiting, so a rule keyed by one counts per client IP; use the signed-in-user key for the built-in forward auth.
- **No placeholders.** Paths, header names and allowlist entries are checked strictly; Caddy placeholders (`{...}`) are refused, so a client-controlled value can never end up in a matcher.
- **Nothing leaks.** Keys (client IPs, header values, user ids) stay in Caddy's memory. They are not logged, and the plugin's Prometheus metrics, which would label every key, are turned off.

## Upgrading

Rate limiting needs the Caddy image of the same release. A Caddy image without the plugin refuses any configuration that uses rate limiting: saving the global defaults is then rolled back with a message, and host changes report that Caddy rejected the configuration. Update both images together.
