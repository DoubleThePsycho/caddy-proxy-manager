# Website screenshots

Dashboard screenshots for the public website (ingres.si, its own repository) and for this repository's README, taken on the end-to-end Docker stack with synthetic data.

```bash
bun run screenshots:site
```

`tests/playwright.shots.config.ts` runs the same global setup and teardown as the e2e suite: it builds and starts the stack, `seed.setup.ts` fills it, `screenshots.spec.ts` takes the pictures, and the teardown removes the stack and `tests/.auth`. Like the e2e suite it needs a test-only `.env` for Docker Compose and the stack's ports free.

## What it seeds

`seed.ts` sets everything up through the REST API, as the admin and as two other people with API tokens, so the audit log names several people: nine proxy hosts on `example.com` and `example.org`, users with `example.com` addresses, custom roles and groups, access lists and blocked sources, an imported certificate that expires in nine days, alert rules, a saved analytics question, an access review, a restore test, a verified audit log and a compliance evidence pack. `db-seed.ts` writes what the API cannot: sign-in history, identity providers (stored turned off), SCIM links and second factors. `data.ts` writes two weeks of traffic straight into ClickHouse with a daily rhythm, a WAF burst a few hours ago and a 502 episode on the API: client addresses only from 192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24 and 2001:db8::/32, AS numbers only from 64496–64511 with made-up names, and OWASP Core Rule Set rule ids.

## Output

Written to `SHOTS_OUTPUT_DIR` (default `test-results/site-screenshots/`), at 1440×900 in the dark theme, re-encoded with a 256-colour palette when `sharp` is installed:

| File | Goes to |
| --- | --- |
| `overview.png`, `analytics.png`, `security-events.png`, `host-editor.png`, `users-and-sign-in.png`, `compliance.png` | the website repository's `site/assets/screenshots/` |
| `preview.png` (1200×630: the product name and a crop of the analytics screenshot, in the dashboard's own fonts) | the website repository's `site/assets/images/preview.png` (og:image) |
| `dashboard.png` | this repository's `.github/assets/dashboard.png` (README) |
| `review/*.png` | full-page captures and other states, for checking only |

Look at every image before copying it: synthetic data only, nothing half-loaded, no error banners.

## Iterating

`SHOTS_KEEP_STACK=1` leaves the stack up after a run; `SHOTS_REUSE_STACK=1` runs against a stack that is already up; `SHOTS_SKIP_SEED=1` skips seeding a stack that is already seeded. The traffic is rewritten on every seeding; the rest of the seed adds to what is there, so seed a fresh stack for the final pictures.
