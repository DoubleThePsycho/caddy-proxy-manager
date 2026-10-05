# Upstream DNS pinning

You can enable upstream DNS pinning globally (**Host defaults → Upstream DNS pinning**, `/proxy-hosts/defaults`) and override it per host in the host editor (**Advanced → Upstream name resolution → Upstream DNS pinning**).

When enabled, hostname upstreams are resolved during config save/reload and written to Caddy as concrete IP dials. Address family selection supports:
- `both` (preferred, resolves AAAA then A with IPv6 preference)
- `ipv6`
- `ipv4`

## Important HTTPS limitation

If one reverse proxy handler contains multiple different HTTPS upstream hostnames, HTTPS pinning is skipped for those HTTPS upstreams to avoid TLS SNI mismatch. In that case, hostname dials are kept for those HTTPS upstreams.

HTTP upstreams in the same handler are still eligible for pinning.
