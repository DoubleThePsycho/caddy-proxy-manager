# Virtual patching

Feature id `virtual_patching`, included in the **Enterprise** edition. Code: `ee/rule-feed/` (Elastic License 2.0). The hooks it uses in the core (the reserved rule id range and the patch rules in `buildWafHandler`, the settings group in instance sync) are MIT.

**Coming soon.** Virtual patching ships switched off in this release (`available: false` for `virtual_patching` in `ee/licensing/features.ts`), and the release trusts no feed signing key yet (`PRODUCTION_KEYS` in `ee/rule-feed/public-keys.ts` is empty). The License page lists it as coming soon and the WAF settings page shows a note in place of the **Virtual patches** section. Subscribing, changing the feed URL, turning on automatic blocking, fetching, importing and turning a patch on answer `403` with any license, and the daily fetch is never scheduled. Reading, unsubscribing, turning automatic blocking off and turning patches off still work. The rest of this page describes the feature as it will work once it is available.

A virtual patch is a WAF rule that stops requests exploiting one known vulnerability (a CVE) while the software behind the proxy waits for its update. Ingressi gets them from a rule feed: one JSON file the vendor publishes and signs, by default at `https://feed.ingres.si/v1/feed.json`. Each patch in it names its CVE ids, the affected software and versions, a severity, references, its rules, and sample requests it matches and lets through.

Patches run on every host where the WAF runs, globally or per host, in the same Coraza handler as the Core Rule Set and your custom rules. They run before the Core Rule Set rules of the same phase, so a blocking patch stops the request itself and the event names the patch. A host with the WAF off gets none.

## Subscribing

1. Install an Enterprise license (**License**).
2. Open **WAF settings**, section **Virtual patches**. Turn on **Fetch daily from** and keep the default URL, or enter a mirror's. The URL must be `https://`; a mirror serves the same signed file, so it cannot change what is installed.
3. **Save subscription**, then **Fetch now**.

The daily fetch runs on the master (or a standalone install), never on a sync replica. It fetches once a day; after a failure it tries again six hours later. The section shows the installed feed (its sequence, when it was fetched or imported, when it expires) and the last fetch with its result or the reason it failed. Redirects are not followed.

## Modes

Each patch is in one of three modes:

| Mode | What it does |
| --- | --- |
| Off | Not in the WAF configuration. |
| Detect | Matching requests are logged as WAF events and reach the upstream. |
| Block | Matching requests get 403 Forbidden on hosts whose WAF blocks. Hosts in detection only log them. |

New patches start in detect, so you can check their events before blocking. Two exceptions: a patch the publisher ships off starts off, and with **Block new critical patches automatically** on, a new critical patch that the publisher recommends blocking starts in block. A patch keeps its mode when a newer feed updates it.

When a patch disappears from the feed, the publisher withdrew it. It keeps its mode and is marked **Withdrawn by the publisher** until you turn it off: a feed alone cannot remove protection you turned on.

Rules that read request bodies (form fields, uploads) only see them on hosts that load the Core Rule Set, or whose custom rules have `SecRequestBodyAccess On`. The patch's details say when it reads bodies.

## Events

WAF events of a patch show **Virtual patch** on **Security events**, with the CVE ids and title as the rule message. The event's details link to the patch on the WAF page, and the patch's details link back to its events. Patch rules have ids from 1,800,000,000 to 1,800,999,999. An exclusion can skip a patch rule on one host or path like any other rule; custom rules may not use these ids.

## Air-gapped installs

On a machine with internet access, download the feed file. Copy it to the install and choose **Import feed file**, or post it to the API:

```bash
curl -X POST https://ingressi.example.com/api/v1/waf/rule-feed/import \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  --data-binary @feed.json
```

An imported feed is verified exactly like a fetched one. Its sequence must be higher than the installed feed's, and it must not have expired: import a new one at least as often as feeds expire (the vendor signs them for 30 days).

## What the signature protects

The feed is signed with Ed25519 over its own context, `ingressi-rule-feed:v1`. The keys it may be signed with are compiled in (`ee/rule-feed/public-keys.ts`) and are not the license keys, so neither kind of signature can stand in for the other. Verification needs no network.

Before anything changes, the whole feed must pass every check:

- **Signature** by a trusted key, named by its key id.
- **Expiry**: not expired, not issued in the future (one day of clock skew is allowed), and valid for at most 90 days.
- **Sequence**: higher than the installed feed's. An older feed is refused (no rollback), and so is a different feed with the installed sequence.
- **Size**: at most 4 MiB, 500 patches, 20 rules per patch, 8 KiB per rule.
- **Schema**: every field of every patch, with unknown fields refused.
- **SecLang allowlist**: only `SecRule`, one per line, reading request variables of phases 1 and 2 (arguments, headers, cookies, the request line, URI, path, query string, body and files). Operators that read files, run programs or reach the network (`@pmFromFile`, `@inspectFile`, `@rbl` and the like) are refused, as are macros in operator arguments and regular expressions RE2 cannot compile. The only actions are `id`, `phase`, `t` (known transformations), `chain`, `capture` and `multiMatch`, and every id must be in the reserved range.

A feed that fails any check is refused whole: nothing is installed, the reason is shown in the section and recorded in the audit log.

Ingressi never passes a rule through as written. It parses each one, checks every part, and writes a new line from the parts, adding the action of the patch's mode (`deny,status:403` or `pass`), a message and tags naming the patch and its CVEs, and the log data the event view redacts credentials from. So a feed, even one signed by a stolen key, cannot:

- switch the WAF engine off or to detection (`SecRuleEngine`, `ctl:ruleEngine`);
- remove or change any other rule (`SecRuleRemove*`, `SecRuleUpdate*`, `ctl:ruleRemove*`), the Core Rule Set's anomaly scores or thresholds (`setvar`), or the defaults of other rules (`SecDefaultAction`);
- skip rules (`skip`, `skipAfter`, `allow`) or hide its own matches (`nolog`);
- read files, include configuration, run programs or set environment variables;
- reuse the ids of your rules.

What a signed feed can still do: block legitimate requests with a rule that matches too much, which is why new patches start in detection and automatic blocking only applies to critical patches; and leave out its own patches in a later feed, which only marks them withdrawn. When Caddy refuses the configuration with new patches, the previous patches are put back and applied again.

The feed is not secret: anyone can read it. Patches that are on keep protecting the hosts when the license lapses, and a subscription that was set up keeps fetching.

## Replicas, export and history

Sync replicas get the patches that are on with the rest of the configuration (the `virtual_patches` settings group), validate and render them again for their own WAF, and show them read-only. They never fetch. A promoted fleet revision carries the master's current patches. Patches are not part of configuration export, backups or history: fetch or import the feed again.

## License

While virtual patching is coming soon, none of the following can be set up with any license (see the top of this page).

Subscribing, changing the feed URL, turning on automatic blocking, fetching on demand, importing and turning a patch on (detect or block) need an active Enterprise license. Unsubscribing, turning automatic blocking off, turning a patch off and reading never do, and neither do the daily fetch of an existing subscription and the patches in the Caddy configuration.

## Permissions

`virtual_patches:read` shows the subscription, the installed feed and the patches; `virtual_patches:write` changes them. The section sits on the WAF page, which also needs `waf:read`.

## REST API

| Endpoint | What |
| --- | --- |
| `GET /api/v1/waf/rule-feed` | Subscription, installed feed, last fetch or import, counts. |
| `PUT /api/v1/waf/rule-feed` | `{subscribed?, feedUrl?, autoBlockCritical?}`. |
| `POST /api/v1/waf/rule-feed/fetch` | Fetch now; `502` with the reason when the feed is refused or cannot be reached. |
| `POST /api/v1/waf/rule-feed/import` | The feed file as the body; `400` with the reason when it is refused. |
| `GET /api/v1/waf/virtual-patches` | Every patch with its CVE details, rules, samples and mode. |
| `GET/PUT /api/v1/waf/virtual-patches/{id}` | One patch; `PUT {"mode": "off" \| "detect" \| "block"}`. |

A sync replica answers changes with `409`. Every change is recorded in the audit log.

## Data

The table `virtual_patches` holds one row per patch with its mode. The setting `virtual_patching` holds the subscription and `virtual_patching_state` the installed feed and the last fetch; both stay on the master.

Publishing the feed: [rule-feed-publishing.md](rule-feed-publishing.md). Example patches for Log4Shell (CVE-2021-44228), Apache HTTP Server 2.4.49 path traversal (CVE-2021-41773) and Spring4Shell (CVE-2022-22965) are in `ee/rule-feed/examples/`, marked as examples.
