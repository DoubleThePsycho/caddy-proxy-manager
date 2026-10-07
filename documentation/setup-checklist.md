# Setup checklist

A fresh install shows a checklist of five steps on the overview, in place of the traffic and hosts, to people who may read the settings ([overview.md](overview.md#first-run)). They can be done in any order. A step is done when the data shows it, or when someone marks it done with **Mark as done** (for example to skip a step that does not apply).

| Step | Done when |
| --- | --- |
| Point a domain at this server | Caddy holds a valid certificate it obtained itself for at least one host, so a domain points here and ports 80 and 443 are reachable. Read from the cached certificate checks described in [the alerting documentation](../ee/docs/alerting.md#certificates-caddy-manages). |
| Add your first proxy host | A proxy host exists. |
| Turn on analytics | ClickHouse analytics is configured (`CLICKHOUSE_PASSWORD`). |
| Invite a teammate | There are at least two users. |
| Set up single sign-on | An enabled OAuth/OIDC provider, SAML provider or LDAP directory exists. |

The checklist is complete when every step is done. **Hide the checklist** hides it; the REST API below shows it again. Either way the overview then shows traffic, hosts and recent changes.

## REST API

| Method and path | Permission |
| --- | --- |
| `GET /api/v1/setup-checklist` | `settings:read` |
| `PUT /api/v1/setup-checklist` `{steps?: {<step>: true\|false}, dismissed?: true\|false}` | `settings:write` |

Step names: `domain`, `first_proxy_host`, `analytics`, `second_user`, `single_sign_on`. Each step in the answer says whether it is `done`, and whether the data (`doneBy: "data"`) or a person (`"manual"`, with `markedAt`) made it so.

```bash
curl -X PUT https://dash.example.com/api/v1/setup-checklist -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"steps":{"analytics":true}}'
```

Changes are recorded in the audit log (`setup_checklist_updated`). The marks are stored on this node only (settings key `setup_checklist`) and are not synced to slave instances.
