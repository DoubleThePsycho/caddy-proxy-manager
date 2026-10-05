# Anonymous usage ping

The usage ping tells the project how many installs are running, on which versions and editions, and which features they use. It helps plan releases: which versions still need fixes, which features deserve more work. It is part of the Community edition and never needs a license.

**It is off until you say yes.** The overview page asks administrators once, with both answers offered alike and neither preselected, and nothing is sent unless the answer is yes. You can change the answer at any time; turning it off deletes what was sent (see [Your choices](#your-choices)).

## Your choices

- **The overview question**, "Share anonymous usage statistics?", is shown to administrators until one of them answers **Yes, share** or **No, don't share**. **See exactly what is sent** shows the JSON first. Closing the page without answering sends nothing and asks again next time.
- **Settings → Usage ping** turns it on or off at any time and shows the exact JSON the next ping sends, the endpoint, the install id, when and how the question was answered and when the last ping went out.
- **`USAGE_PING_ENABLED=true`** answers yes for installs nobody signs in to, at the next start of the web container. It never overrides an answer already given (an administrator can still turn it off), and only `true`, `1`, `yes` or `on` count, so a typo sends nothing.
- **`USAGE_PING_DISABLED=true`** turns it off entirely (see [Turning it off for good](#turning-it-off-for-good)).
- **REST API:** `GET /api/v1/usage-ping` (permission `settings:read`) returns the setting and the payload preview; `PUT /api/v1/usage-ping` with `{"enabled": true}` or `{"enabled": false}` (`settings:write`) turns it on or off; `POST /api/v1/usage-ping/reset-install-id` (`settings:write`) replaces the install id.

**Turning it on** creates a new random install id; the first ping goes out a few minutes later. **Turning it off** deletes the install id and the send history on the install. If a ping may already have reached the receiving service, the install also asks it to delete everything it stored for that id (a `DELETE` with just the id); if that request fails, it is retried every 6 hours for 7 days. **Reset** replaces the install id the same way and asks for the old one's data to be deleted. Turning it on again creates a new id. Each answer and change is recorded in the audit log as `usage_ping_enabled`, `usage_ping_disabled` or `usage_ping_install_id_reset`, with the administrator who gave it (or no user, for `USAGE_PING_ENABLED`); the audit log never contains the install id.

## What is sent

One JSON document, once a day:

```json
{
  "schema": 1,
  "install_id": "0b6f3c1e-2a4d-4f8e-9c3b-5d7e1f2a3b4c",
  "version": "2.0.0",
  "edition": "community",
  "role": "standalone",
  "counts": { "proxy_hosts": "6-20", "l4_hosts": "0", "users": "1-5", "replicas": "0" },
  "features": {
    "waf": true, "forward_auth": false, "clickhouse_analytics": true, "rate_limiting": false,
    "sso_saml": false, "sso_enforce": false, "custom_roles": false, "audit_streaming": false,
    "alerting": false, "config_history": false, "scheduled_backups": false, "ai_analyst": false,
    "approvals": false, "compliance_reports": false, "scim": false, "access_reviews": false,
    "ldap": false, "fleet": false, "high_availability": false, "multi_tenancy": false,
    "white_label": false, "api_monetization": false, "virtual_patching": false
  },
  "arch": "x64"
}
```

| Field | What it is |
| --- | --- |
| `schema` | Version of this format (1). |
| `install_id` | A random UUID v4, created when the ping is turned on. It is not derived from anything (not the hostname, the license or the database). **Reset** in Settings replaces it; turning the ping off deletes it. |
| `version` | The release this install runs, or `unknown`. |
| `edition` | `community`, or the name of the licensed edition (`homelab`, `business`, `enterprise`, `msp`) while a license is active or in its grace period. Never the license id or the customer. |
| `role` | `standalone`, or `master` for an instance sync master. Slaves never send. |
| `counts` | Proxy hosts, L4 hosts, active dashboard users and the slaves a master syncs to, each only as a range: `0`, `1-5`, `6-20`, `21-100` or `101+`. |
| `features` | Whether each feature is in use, as `true` or `false`: the WAF on at least one enabled proxy host, forward auth on at least one enabled proxy host, ClickHouse analytics configured, rate limiting rules applying to at least one enabled proxy host, and each paid feature set up (by its feature id). Never how it is configured. `virtual_patching` is always `false`: that feature was withdrawn before it shipped, and the field stays until the next `schema` version. |
| `arch` | The CPU architecture (`x64`, `arm64`, ...). |

**Never sent:** hostnames, domains, IP addresses, e-mail addresses, user or display names, license ids or customer names, configuration contents (upstreams, rules, certificates, secrets), and nothing from access, WAF or audit logs.

The receiving service refuses any document that is not exactly this shape, so a field cannot be added without a new `schema` version there.

## When it is sent

- The first ping goes out a few minutes after the ping is turned on, then once a day at a minute picked at random, so installs do not all send at once.
- One `POST` with a 10-second time limit, without cookies or credentials. Redirects are not followed. A failure is not retried before the next day and is logged as one line, at most once a day. Nothing else in the dashboard waits for it or depends on it.
- Instance sync slaves never send. The setting is per install: it is not synced to slaves, and it is not part of the configuration export, history or backups, so a restored export or a new slave never inherits the install id.

## Verifying it

- **The preview.** Settings → Usage ping and `GET /api/v1/usage-ping` show the payload built by the same function that builds the ping, from the same data, at that moment. While the ping is off or unanswered, `install_id` shows a placeholder.
- **The source.** `src/lib/usage-ping/payload.ts` defines every field and is the only code that builds the document; `src/lib/usage-ping/collect.ts` is where each value comes from; `src/lib/usage-ping/scheduler.ts` sends it.
- **The receiver.** A Cloudflare Worker run by the Ingressi vendor at `ping.ingres.si` receives it; [What the receiver keeps](#what-the-receiver-keeps) lists everything it stores.

## Turning it off for good

Set `USAGE_PING_DISABLED=true` in the web container's environment (with the stock `docker-compose.yml`, in `.env`) and recreate it (`docker compose up -d`). Nothing is sent, the question is hidden and the setting cannot be turned on, whatever was answered before. With it set, no deletion request is sent either: data received earlier is deleted by the receiving service after 90 days. Use it for air-gapped and regulated installs; the air-gapped bundle sets it already.

`USAGE_PING_URL` sends the ping to another endpoint instead, for example one of your own that accepts the same JSON document. It must be an `https://` URL without credentials; if it is not, nothing is sent and Settings says why.

## What the receiver keeps

The receiver keeps one row per install:

- a SHA-256 of the install id (the id itself is not stored);
- the first and last day a ping was accepted, and when the last one was accepted;
- the latest version, edition, role, ranges and feature flags.

It does not store IP addresses, user agents or any other request metadata, and its request logs are turned off. It keeps at most one ping per install every 12 hours and deletes installs not seen for 90 days. The data is stored in the EU. Only totals are read from it: active installs in the last 7 and 30 days by version, edition and role, and how many use each feature.

## Privacy notice

This section is the information Articles 13 and 14 of the GDPR require for the usage ping.

- **Controller:** FUO.FI Cybersecurity di Nicolò Campari (P.IVA 04388461206), the publisher of Ingressi. The postal address is on the [imprint](https://ingres.si/legal/imprint/). Privacy contact: [privacy@ingres.si](mailto:privacy@ingres.si).
- **What is processed:** the JSON document above. The install id is random and the rest is ranges and yes/no answers, but the id singles out one install, which can belong to one person (a homelab), so it is treated as personal data. The IP address the request comes from is seen by the receiving service's provider in transit and is not stored.
- **Purpose:** knowing how many installs run which versions, editions and features, to decide which releases still need security fixes, what to support and what to deprecate.
- **Legal basis:** consent (Article 6(1)(a) GDPR), which also covers sending information from your server under Article 5(3) of the ePrivacy Directive (in Italy, Article 122 of the Privacy Code). Nothing is sent unless an administrator answers yes or the operator sets `USAGE_PING_ENABLED`; both answers are offered alike and neither is preselected. An install only ever sends after a yes, and its audit log records who answered and when.
- **Recipients:** Cloudflare, Inc. hosts the receiving service as a processor under its Data Processing Addendum. The data is stored in Cloudflare's EU jurisdiction. Cloudflare is certified under the EU-U.S. Data Privacy Framework and also offers the Standard Contractual Clauses for transfers. Nobody else receives it; only totals are ever read or published.
- **Retention:** 90 days after the last ping, then deleted automatically; deleted at once when the ping is turned off.
- **Withdrawing consent:** turn the ping off at any time, in Settings or through the API, as easily as it was turned on. That also erases what was received. Withdrawing does not affect the lawfulness of what was sent before.
- **Your rights:** You can see the id the data is stored under in Settings, and ask the controller for access, rectification, erasure or restriction at the contact above. You can complain to a supervisory authority, in Italy the Garante per la protezione dei dati personali.
- **No automated decisions** are made with it, and nobody is profiled.
