# Settings

**Settings** holds the defaults for every host and how this install runs. A host's own settings win over these.

## Groups

The list on the left gathers the settings in groups:

| Section | Group | What it holds |
| --- | --- | --- |
| System | General | Primary domain, the dashboard address (`BASE_URL`, read-only) and the answer to requests for unknown hosts ([default-response.md](default-response.md)) |
| System | Certificates and ACME | Let's Encrypt or your own ACME directory, the contact e-mail, DNS-01 providers and resolvers, certificate storage |
| System | Instance sync | Standalone, master or replica, the replicas of a master and their sync key pins ([instance-sync.md](instance-sync.md)) |
| System | High availability | The dashboard cluster, read-only: leader, standbys, replication and the last restore ([high-availability.md](../ee/docs/high-availability.md#dashboard-cluster)) |
| System | Backups | A summary of scheduled backups; they are set up under **Change history → Backups** |
| System | Usage ping | The anonymous usage ping ([usage-ping.md](usage-ping.md)) |
| Networking | Trusted proxies, Upstream DNS pinning | The real client address behind a proxy, and pinned upstream addresses ([upstream-dns-pinning.md](upstream-dns-pinning.md)) |
| Security defaults | Geo blocking and GeoIP, Rate limiting, Error pages, Forward auth defaults, OAuth providers | Defaults for every host, the GeoLite2 databases, and dashboard sign-in providers ([geo-blocking.md](geo-blocking.md), [forward-auth.md](forward-auth.md), [oauth.md](oauth.md)) |
| Observability | Analytics and logs | ClickHouse status and retention (set in the environment), the access log and Prometheus metrics |
| Appearance | Branding | A link to the Branding page (MSP edition) |

The search field above the list filters the groups by name, description and the words people use for them, such as `redis`, `prometheus` or `wildcard`. On a phone the list is a drop-down.

## Saving

Each group has one save bar. It counts the fields you changed; **Save changes** saves every changed card of the group, and **Discard** puts the group back as it was loaded. A group with unsaved changes is marked **Unsaved** in the list, and the changes stay while you look at another group. Certificate storage, DNS-01 providers, OAuth providers, replicas and the usage ping save each change on their own, since they ask for confirmation or credentials.

## Links

`/settings?section=<id>` opens a group: `general`, `acme`, `sync`, `high-availability`, `backups`, `usage-ping`, `trusted-proxies`, `upstream-dns`, `geoblock`, `rate-limit`, `error-pages`, `forward-auth`, `oauth`, `analytics` or `branding`. The ids of the sections the page had before still work and open the group that holds them, scrolled to their card: `default-response`, `dns-providers`, `dns-resolvers`, `certificate-storage`, `authentik`, `metrics` and `logging`.

The settings REST API (`/api/v1/settings/...`) is unchanged.
