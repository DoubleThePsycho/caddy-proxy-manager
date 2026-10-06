# Licenses

A license key unlocks setting up and changing the paid features of its edition. It never touches traffic: proxying, certificates, the WAF, sign-in and every paid feature already configured keep working without one, with an expired one or with a removed one. How gating works in the code: [../README.md](../README.md).

## Editions and prices

| Edition | Price (excluding VAT) | Nodes included | How it is sold |
| --- | --- | --- | --- |
| Homelab | €49 a year | 1, non-commercial use | Online, once checkout opens |
| Business | €890 a year, or €89 a month | 3, then €190 a year (€19 a month) per extra node | Online, once checkout opens |
| Enterprise | from €5,900 a year | 10, then €290 a year per extra node | Annual, usually invoiced |

A node is the dashboard itself plus each instance sync replica it manages. Going over the licensed number shows a notice on the License page and is invoiced at renewal; nothing is ever blocked.

## Buying

Online checkout is not open yet. Organisations buy by writing to [sales@ingres.si](mailto:sales@ingres.si) with the edition, the number of nodes and the company name the key is issued to. Every edition is invoiced directly for now; Enterprise always is.

1. Once the order is settled, `licenses@ingres.si` e-mails the license id, the license key (also attached as a `.lic` file) and a refresh token for automatic updates. Keep that e-mail: the refresh token is sent only once.
2. Install the key (below).

Each renewal issues a new key for the same license id and e-mails it. A key is valid until the end of the paid period plus a week; after that the 30-day grace period still lets you change paid features. If you do not renew, nothing else happens: the last key runs out on its own.

Invoices, more nodes and cancellation: write to [sales@ingres.si](mailto:sales@ingres.si).

## Trial

The website's trial form gives a 14-day Business (3 nodes) or Enterprise (10 nodes) trial key. Enter your company and work e-mail; a confirmation link arrives by e-mail and is valid for 48 hours. Opening it and selecting **Send the trial key** e-mails the key. A trial key shows **Trial** on the License page.

A trial is one-time only: one per e-mail address and per company domain, ever (for public mailbox providers such as Gmail, only the address counts). For an extension, write to [sales@ingres.si](mailto:sales@ingres.si). When the trial ends, what you set up keeps running; buy a license (above) to keep changing it. The purchase sends a new key with its own license id; install it over the trial key.

## Installing a key

1. Sign in with an account that may change the license (the `license:write` permission; administrators have it).
2. Open **Administration → License**.
3. Paste the key under **Install a key**, or choose the `.lic` file from the e-mail, and select **Verify key**. The dashboard checks the signature on this machine and shows what the key grants: edition, nodes, expiry and features.
4. Select **Install key**. It replaces the current key at once and is recorded in the audit log.

With the REST API: `POST /api/v1/license/verify` checks a key without installing it, and `PUT /api/v1/license` with `{"key": "<license key>"}` installs it. Both need `license:write`.

Keys are verified offline against the public keys built into each release, so air-gapped installs work the same way. There is no environment variable for the key; install it through the page or the API.

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

If a check says the license was revoked (after a refund, for example), the installed key keeps working until it expires; keys are verified offline, so an issued key cannot be withdrawn.

The refresh token is stored encrypted, is never shown again or returned by the API (`hasRefreshToken` says whether one is stored), and is deleted when the setting is turned off. The setting is per install and is not synced to replicas or included in configuration exports. Lost the token? Reply to a license e-mail for a new one.

REST API: `GET /api/v1/license/auto-update` (`license:read`), `PUT /api/v1/license/auto-update` with `{"enabled": true, "refreshToken": "lrt_…"}` or `{"enabled": false}` (`license:write`), and `POST /api/v1/license/auto-update/check` (`license:write`).

| Variable | Default | Meaning |
| --- | --- | --- |
| `LICENSE_AUTO_UPDATE_DISABLED` | `false` | `true` forbids automatic updates: the license server is never contacted. Air-gapped bundles set it. |
| `LICENSE_SERVER_URL` | `https://license.ingres.si` | Another license server (https only; an invalid value means nothing is sent). |

## Lost the key

The key is in the license e-mail, also as a `.lic` file. If that e-mail is gone, write to [sales@ingres.si](mailto:sales@ingres.si) from the address the key was sent to.

## When a license ends

| When | What happens |
| --- | --- |
| Until the expiry | Everything works and can be changed. |
| 30 days after the expiry (grace period) | Paid features stay editable. Renew before it ends. |
| After the grace period | Paid features keep running but are read-only. Deleting or turning them off still works. |

Installing a renewed key ends the grace period or the read-only state at once.

For the vendor: the license server that sells and issues keys lives in a separate private repository (`ingres-si/license-server`).
