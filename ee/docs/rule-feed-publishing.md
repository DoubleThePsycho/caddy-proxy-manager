# Publishing the rule feed

For the vendor. How installs use the feed: [virtual-patching.md](virtual-patching.md).

## Signing key

```bash
bun ee/scripts/rule-feed-keygen.ts --kid 2026-10
```

The private key goes to `~/.config/ingressi/rule-feed-signing-2026-10.pem` (mode 0600). Keep it offline and in a password manager; it never enters the repository, CI or the feed host. Add the printed public key to `PRODUCTION_KEYS` in `ee/rule-feed/public-keys.ts` and ship a release: installs trust only the keys their release contains. Until a key is there, every feed is refused.

To rotate: create a key with a new `--kid`, add it next to the old one, sign with the new key once installs run that release, then remove the old entry in a later release. A stolen key is handled the same way, faster: installs keep the feed they have and refuse later ones signed by a key their release no longer trusts.

## Packs

One JSON file per patch in a directory, for example `packs/ivp-2021-44228.json`. `ee/rule-feed/examples/` has three; copy one to start.

| Field | What |
| --- | --- |
| `id` | Stable id, 3-64 lowercase letters, digits and dashes, e.g. `ivp-2021-44228`. Never reuse one for a different patch. |
| `cves` | One or more CVE ids. |
| `title`, `summary` | Shown on the WAF page; the title and CVE ids also become the rule message in WAF events. |
| `affected` | `[{product, versions, fixed?}]`. |
| `severity` | `critical`, `high`, `medium` or `low`. |
| `publishedAt`, `updatedAt` | ISO 8601 times. Change `updatedAt` when the rules change. |
| `references` | `https://` URLs (advisories, NVD). |
| `defaultMode` | `block`: safe to block (critical ones may be blocked automatically). `detect`: let administrators decide. `off`: ship it off. |
| `rules` | SecRule lines, see below. |
| `samples` | `{positive: [...], negative: [...]}`: requests the rules must match and must let through, each `{method, path, headers?, body?}`. At least one positive. |
| `example` | `true` only for examples; the signing script refuses them. |

## Rules

Each entry of `rules` is one `SecRule` on one line, exactly `SecRule VARIABLES "@operator argument" "actions"` with single spaces:

- **Variables**: request variables of phases 1 and 2, e.g. `ARGS`, `ARGS_NAMES`, `REQUEST_HEADERS:User-Agent`, `REQUEST_COOKIES`, `REQUEST_LINE`, `REQUEST_URI_RAW`, `REQUEST_FILENAME`, `QUERY_STRING`, `REQUEST_BODY`, `FILES_NAMES`, with keys or `/regex/` keys, `!` exclusions and `&` counts.
- **Operators**: `@rx` (RE2: no lookarounds or backreferences), `@pm`, `@streq`, `@contains`, `@beginsWith`, `@endsWith`, `@within`, `@strmatch`, `@eq`/`@ge`/`@gt`/`@le`/`@lt`, `@ipMatch`, `@detectSQLi`, `@detectXSS`, `@validateByteRange`, `@validateUrlEncoding`, `@validateUtf8Encoding`; `!` negates. No `"`, no `%{` and no trailing backslash in arguments.
- **Actions**: `id` (required, from 1800000000 to 1800999999, unique across the whole feed), `phase` (required, 1 or 2), `t:` transformations, `chain`, `capture`, `multiMatch`. Nothing else: installs add the action of the patch's mode, the message, tags, severity and log data themselves.
- A rule with `chain` continues into the next entry, written the same way but without `id` or `phase` (its actions may be empty, `""`, or `t:none`).

Pick phase 1 for the request line and headers, phase 2 when the rule reads arguments that can come in a form body (phase 2 also sees the query string). Bodies are only inspected on hosts that load the Core Rule Set.

## Building and signing

```bash
bun ee/scripts/rule-feed-sign.ts --key ~/.config/ingressi/rule-feed-signing-2026-10.pem \
  --kid 2026-10 --packs ./packs --out feed.json
```

The script validates every pack exactly as installs do, checks each sample against the rules with an approximate evaluator (a positive sample that does not match, or a negative one that does, stops the build), signs, and verifies the result before writing it. `--sequence` defaults to the current Unix time, which increases with every build; installs refuse a sequence that is not higher than theirs. `--days` sets the lifetime (default 30, at most 90).

The evaluator is not Coraza. Before publishing a new rule, load it in a test install (import the feed there) and send the samples through Caddy.

Sign a new feed at least weekly, even without new patches, so subscribed installs never hold an expired feed and air-gapped installs have a fresh file to import.

## Hosting

The feed is one static file; nothing else is needed. Serve it over HTTPS at a stable URL, by default `https://feed.ingres.si/v1/feed.json`:

- **Cloudflare R2**: a bucket with a custom domain (`feed.ingres.si`), the file uploaded as `v1/feed.json` with `Content-Type: application/json` and `Cache-Control: public, max-age=300`. Or Workers static assets with the file at the same path.
- **Any HTTPS server or object store** works the same way.

Installs do not follow redirects, so serve the file at the URL itself. Replace the file in place for each build; there is no index or history to maintain. Mirrors copy the file unchanged: the signature, not the host, is what installs trust.
