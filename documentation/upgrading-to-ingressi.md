# Upgrading from Caddy Proxy Manager to Ingressi

Caddy Proxy Manager is now called Ingressi. The rename reaches the names the product uses on the wire and on disk too. Every old name keeps working for existing installs, so an upgrade needs no action. The table lists what changed and how long the old name keeps working.

| What | Old name | New name | Old name after the upgrade |
| --- | --- | --- | --- |
| Identity headers sent to upstreams by Ingressi forward auth | `X-CPM-User`, `X-CPM-Email`, `X-CPM-Groups`, `X-CPM-User-Id` | `X-Ingressi-User`, `X-Ingressi-Email`, `X-Ingressi-Groups`, `X-Ingressi-User-Id` | Still sent, with the same values, and still stripped from clients. Deprecated: switch upstreams to the new names. |
| Forward-auth session cookie on protected sites | `_cpm_fa` | `_ingressi_fa` | Accepted, so nobody is signed out. Replaced by the new cookie at the next sign-in. |
| Forward-auth callback path on protected sites | `/.cpm-auth/callback` | `/.ingressi-auth/callback` | Still routed, for sign-ins started before the upgrade. |
| Internal headers between Caddy and the dashboard | `X-CPM-Forward-Auth-Proof`, `X-CPM-Proxy-Host-Id`, `X-CPM-Portal-Target` | `X-Ingressi-…` | Accepted until the dashboard re-applies the Caddy configuration, which it does on start. |
| REST field for Ingressi forward auth on proxy hosts | `cpmForwardAuth` | `ingressiForwardAuth` | Accepted on input when `ingressiForwardAuth` is absent, and returned next to it. Deprecated. Sending both with different values is refused. |
| SQLite database file | `caddy-proxy-manager.db` | `ingressi.db` | When `DATABASE_URL` names `ingressi.db`, the file does not exist and `caddy-proxy-manager.db` is in the same directory, the old file and its `-wal`/`-shm`/`-journal` files are renamed on start. A compose file that still names the old file keeps using it. |
| Docker images | `ghcr.io/fuomag9/caddy-proxy-manager-{web,caddy,l4-port-manager}` | `ghcr.io/ingres-si/ingressi-{web,caddy,l4-port-manager}` (the project moved to the ingres-si GitHub organization) | Every release is pushed under both names, so watchtower and old compose files keep updating. |
| Container names in `docker-compose.yml` | `caddy-proxy-manager-*` | `ingressi-*` | The L4 port manager finds a caddy container under either name. Scripts that address containers by name need the new names once you use the new compose file. |
| Caddy HTTP server name | `cpm` | `ingressi` | Changed. Prometheus metrics carry it as the `server` label: update dashboards and alerts that filter on `server="cpm"`. |
| Default ClickHouse user | `cpm` | `ingressi` | The bundled ClickHouse container recreates its user from `CLICKHOUSE_USER` on every start, so nothing is needed. If you run your own ClickHouse and never set `CLICKHOUSE_USER`, set `CLICKHOUSE_USER=cpm`. |
| Default `PRIMARY_DOMAIN` | `caddyproxymanager.com` | `ingressi.localhost` | Only the placeholder site Caddy serves before the first configuration is applied. |

## What stays as it was

These names predate the rename and do not change, because changing them would break existing data or replicas on older versions:

- The Docker volume names (`caddy-manager-data`, `caddy-data`, …): renamed volumes would start empty.
- The proxy-host setting key `cpm_forward_auth` stored in the database, configuration exports and instance-sync payloads.
- The key-derivation labels used to encrypt stored secrets and instance-sync payloads.
- Environment variable names. None carried the old name.
- The GitHub repository name: it moved to the ingres-si organization as `ingres-si/caddy-proxy-manager`, and GitHub redirects the old URLs.

## Mixed versions with instance sync

The master and its replicas can run different versions during an upgrade. Proxy hosts reach older replicas under the old setting key, and each instance generates its own Caddy configuration, so forward auth keeps working on every instance.
