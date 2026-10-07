# Licenses

A license key unlocks setting up and changing the paid features of its edition. It never touches traffic: proxying, certificates, the WAF, sign-in and every paid feature already configured keep working without one, with an expired one or with a removed one. How gating works in the code: [../README.md](../README.md).

## Editions and prices

| Edition | Price (excluding VAT) | Nodes included | How it is sold |
| --- | --- | --- | --- |
| Homelab | €49 a year | 1, non-commercial use | Online, yearly |
| Business | €890 a year, or €89 a month | 3, then €190 a year (€19 a month) per extra node | Online, yearly or monthly |
| Enterprise | from €5,900 a year | 10, then €290 a year per extra node | By written order, usually invoiced |

A node is the dashboard itself plus each instance sync replica it manages. Going over the licensed number shows a notice on the License page and blocks nothing; the extra nodes are due from the next renewal.

## Buying

Homelab and Business are sold online on [ingres.si/pricing](https://ingres.si/pricing/), through Stripe Managed Payments: the seller is Sold through Link, LLC, which charges VAT and sends the receipt and the invoice. Business extra nodes can be added at checkout. Enterprise, and any order by invoice, goes through [sales@ingres.si](mailto:sales@ingres.si): give the edition, the number of nodes and the company name the key is issued to.

1. After payment, `licenses@ingres.si` e-mails the license id, the license key (also attached as a `.lic` file) and a refresh token for automatic updates. Keep that e-mail: the refresh token is sent only once.
2. Install the key (below).

Subscriptions renew automatically. Each renewal issues a new key for the same license id and e-mails it. A key is valid until the end of the paid period plus a week; then the 30-day grace period still lets you change paid features. Cancelling stops the next renewal, and the last key runs out on its own.

Receipts, payment method and cancellation: your Link account at [app.link.com](https://app.link.com). More nodes after checkout, or another edition: [sales@ingres.si](mailto:sales@ingres.si).

## Trial

The website's trial form gives a 14-day Business (3 nodes) or Enterprise (10 nodes) trial key. Enter your company and work e-mail; a confirmation link arrives by e-mail and is valid for 48 hours. Opening it and selecting **Send the trial key** e-mails the key. A trial key shows **Trial** on the License page.

A trial is one-time only: one per e-mail address and per company domain, ever (for public mailbox providers such as Gmail, only the address counts). For an extension, write to [sales@ingres.si](mailto:sales@ingres.si). When the trial ends, what you set up keeps running; buy a license (above) to keep changing it. The purchase sends a new key with its own license id; install it over the trial key.

## Installing a key

1. Sign in with an account that may change the license (the `license:write` permission; administrators have it).
2. Open **Administration → License**.
3. Paste the key under **Install a key**, or choose the `.lic` file from the e-mail, and select **Verify key**. The dashboard checks the signature on this machine and shows what the key grants: edition, nodes, expiry and features.
4. Select **Install key**. It replaces the current key at once and is recorded in the audit log.

With the REST API: `POST /api/v1/license/verify` checks a key without installing it, and `PUT /api/v1/license` with `{"key": "<license key>"}` installs it. Both need `license:write`.

Every key's signature is verified on the install, against the public keys built into each release. A key from ingres.si (bought or a trial) is also confirmed with the license server once a day (below); an install that must never call out, such as an air-gapped one, needs an offline key: ask [sales@ingres.si](mailto:sales@ingres.si). There is no environment variable for the key; install it through the page or the API.

## Online confirmation

Keys from ingres.si (purchases and trials) are online keys: the License page shows **Online key** next to the status. The install confirms such a key with the license server once a day. Offline keys (issued on request for air-gapped installs) are never checked online.

- **What is sent.** The leader node (a standalone install, or the instance sync master; replicas never ask) sends one request to `https://license.ingres.si` (or `LICENSE_SERVER_URL`): `POST /v1/licenses/<license id>/status` with `{"keySha256": "<SHA-256 of the installed key>"}`. Nothing else about the install is sent. The license server records when the license was last confirmed, at most once an hour.
- **What comes back.** A statement signed by the license server, saying the license is active (for the next 14 days) or revoked. It counts only if its signature verifies with the public keys built into the release and it is about the installed license.
- **When.** Right after an online key is installed, then once a day. After a failed attempt the install tries again within the hour. **Check now** on the License page, or `POST /api/v1/license/check` (`license:write`), asks right away, at most once a minute.

| Online check | Meaning |
| --- | --- |
| Confirmed | A current confirmation. Each one counts for 14 days, so paid settings stay editable through 14 days without an answer. |
| Not confirmed yet | A new online key has no confirmation yet. It works for 7 days after the install first saw the license; removing and reinstalling the key does not restart them. |
| Not confirmed | No current confirmation: paid settings are read-only until the license server confirms the license again. Allow outbound HTTPS to `license.ingres.si`, or ask for an offline key. |
| Revoked | The license was revoked: after a refund, a chargeback, or a key shared beyond the license. Paid settings are read-only at once, with no grace period. |

Whatever the confirmation says, traffic is never touched: proxying, certificates, the WAF, sign-in and every paid feature already configured keep running, as with an expired license. A revoked license that is reinstated (for example after a chargeback decided in the customer's favour) is editable again from the next check. The overview's **Needs attention** lists a license that is revoked, not confirmed, or not confirmed for more than a day after it was installed. The audit log records `license_revoked` and `license_reinstated` when the license server's answer changes.

## Keeping the license up to date automatically

Off by default. With it on, renewed keys install themselves; with it off, install each renewal's key by hand as above.

1. Open **Administration → License → Automatic updates**.
2. Turn on **Keep the license up to date automatically** and paste the refresh token from the license e-mail (`lrt_` followed by 43 characters). The dashboard asks the license server once right away; a token the server does not accept is refused and nothing is stored.

Then, once a day at a random minute, the leader node (a standalone install, or the instance sync master; replicas never ask) sends one request to `https://license.ingres.si`: `GET /v1/licenses/<license id>/current`, with the refresh token as a bearer token. Nothing else about the install is sent. It installs the key that comes back only when:

- its signature verifies with the public keys built into this release,
- it is for the same license id as the installed key,
- it was issued after the installed key, and
- it could be installed by hand (not past its grace period).

The card shows the last check, its result, the next check and the last time a key was installed; **Check now** asks right away (at most once a minute). Every automatic installation is in the audit log as `license_auto_updated`; turning the setting on or off and replacing the token are logged as `license_auto_update_enabled`, `license_auto_update_disabled` and `license_auto_update_token_replaced`.

| Status | Meaning |
| --- | --- |
| On | Checked daily. |
| Off | The setting is off. |
| Turned off by the environment | `LICENSE_AUTO_UPDATE_DISABLED` is set: nothing is ever sent and the setting cannot be turned on. |
| Replica: never checks | This instance is a sync replica. |
| Not checking | `LICENSE_SERVER_URL` is not a valid https URL. |
| Token for another license | A different license was installed since; enter that license's refresh token. |
| No license to update | No valid key is installed. |

Automatic updates are separate from the online confirmation above, which runs whether they are on or not. If an update check says the license was revoked (after a refund, for example), no renewed key is installed; for an online key, the online confirmation makes paid settings read-only.

The refresh token is stored encrypted, is never shown again or returned by the API (`hasRefreshToken` says whether one is stored), and is deleted when the setting is turned off. The setting is per install and is not synced to replicas or included in configuration exports. Lost the token? Reply to a license e-mail for a new one.

REST API: `GET /api/v1/license/auto-update` (`license:read`), `PUT /api/v1/license/auto-update` with `{"enabled": true, "refreshToken": "lrt_…"}` or `{"enabled": false}` (`license:write`), and `POST /api/v1/license/auto-update/check` (`license:write`).

| Variable | Default | Meaning |
| --- | --- | --- |
| `LICENSE_AUTO_UPDATE_DISABLED` | `false` | `true` forbids automatic updates: renewed keys are never fetched. It does not stop the online confirmation of a key from ingres.si. Air-gapped bundles set it. |
| `LICENSE_SERVER_URL` | `https://license.ingres.si` | Another license server for the online confirmation and automatic updates (https only; an invalid value means nothing is sent). |

## Lost the key

The key is in the license e-mail, also as a `.lic` file. If that e-mail is gone, write to [sales@ingres.si](mailto:sales@ingres.si) from the address the key was sent to.

## When a license ends

| When | What happens |
| --- | --- |
| Until the expiry | Everything works and can be changed. |
| 30 days after the expiry (grace period) | Paid features stay editable. Renew before it ends. |
| After the grace period | Paid features keep running but are read-only. Deleting or turning them off still works. |
| Revoked, or an online key not confirmed | The same as after the grace period, at once. |

Installing a renewed key ends the grace period or the read-only state at once.

For the vendor: the license server that sells and issues keys lives in a separate private repository (`ingres-si/license-server`).
