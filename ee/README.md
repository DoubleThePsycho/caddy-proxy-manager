# ee/: paid editions

Code in this directory is source-available under the [Elastic License 2.0](LICENSE), not MIT. You may read, run and modify it, but you may not offer it as a managed service or move, change, disable or circumvent the license-key checks. Everything outside `ee/` is [MIT](../LICENSE).

All paid functionality lives here. Next.js only finds pages and API routes under `app/`, so each paid page or route keeps a file there that only re-exports its implementation from `ee/` and contains no paid functionality (see [Where paid code lives](#where-paid-code-lives)).

## How gating works

- `licensing/features.ts` lists every paid feature and the edition that includes it. Anything not listed there is Community and is never gated.
- A license only controls **setting up, enabling or changing** a paid feature (`requireFeature()` in `licensing/store.ts`). Deleting or disabling paid configuration never needs one, so an install whose license lapsed can always wind a feature down. Nothing on the request path checks it: traffic, TLS, the WAF, sign-in and paid features that are already configured keep working with an expired, removed or invalid key.
- An expired license keeps its features editable for a 30-day grace period, then they turn read-only.
- Node counts are informational: going over the licensed number shows a notice and never blocks anything.

## License keys

Keys are Ed25519-signed JSON verified offline (`licensing/license.ts`), so air-gapped installs work. Trusted public keys live in `licensing/public-keys.ts`.

```bash
# once per signing key; the private key stays outside the repository
bun ee/scripts/license-keygen.ts --kid 2026-10
# issue a key
bun ee/scripts/license-sign.ts --key ~/.config/ingressi/license-signing-2026-10.pem \
  --kid 2026-10 --customer "Example S.r.l." --edition business --nodes 3 --days 365
```

Install a key from **License** in the dashboard or with `PUT /api/v1/license`. The dashboard checks the key first and shows what it grants (edition, nodes, expiry, features) before anything changes; `POST /api/v1/license/verify` does the same check without installing the key. Both need `license:write`.

Trials and renewals come from the license server (a separate private repository, `ingres-si/license-server`) (Stripe, Cloudflare Worker), signed with a separate online key (`online-…`) that is also listed in `licensing/public-keys.ts`. Online checkout is not open yet: keys are sold through sales@ingres.si, and the license server will issue the keys bought online once checkout opens. Installs can fetch renewed keys themselves once a day when an administrator turns on automatic updates with the license's refresh token (`licensing/auto-update.ts`); it is off by default. Customer-facing steps: [docs/licenses.md](docs/licenses.md).

## Where paid code lives

Every paid feature, the `ee/` module that implements it and the files in `app/` that route to it. The routing files are listed in `boundary.ts` (`PAID_ROUTES`), and `tests/unit/license-boundary.test.ts` fails when one of them holds anything but a shim.

| Feature | Edition | `ee/` module | Routed to from `app/` |
| --- | --- | --- | --- |
| Access reviews (`access_reviews`) | Enterprise | `access-reviews/` | `(dashboard)/access-reviews/`, `(dashboard)/my-reviews/`, `api/v1/access-review-assignments/`, `api/v1/access-review-schedules/`, `api/v1/access-reviews/` |
| AI analyst (`ai_analyst`) | Homelab | `ai/` | `api/v1/ai/`, `api/v1/analytics/questions/`, `api/v1/waf/tuning-suggestions/` |
| Alerting (`alerting`) | Homelab | `alerting/` | `(dashboard)/alerts/`, `api/v1/alert-channels/`, `api/v1/alert-events/`, `api/v1/alert-rules/` |
| Change approvals (`approvals`) | Enterprise | `approvals/` | `(dashboard)/approvals/`, `api/v1/approval-policies/`, `api/v1/change-requests/` |
| Audit streaming and export (`audit_streaming`) | Business | `audit/` | `(dashboard)/audit-log/streaming/`, `api/v1/audit-sinks/`, `api/v1/audit-log/export/`, `api/v1/audit-log/retention/`, `api/v1/audit-log/verify/` |
| Scheduled backups (`scheduled_backups`) | Business | `backups/` | `(dashboard)/backups/`, `api/v1/backup-destinations/`, `api/v1/backup-runs/` |
| Compliance reports (`compliance_reports`) | Enterprise | `compliance/` | `(dashboard)/compliance/`, `print/compliance/`, `api/v1/compliance/` |
| Configuration history and rollback (`config_history`) | Homelab | `config-history/` | `(dashboard)/history/`, `api/v1/config-history/` |
| Custom roles (`custom_roles`) | Business | `custom-roles/` | `api/v1/roles/`, `api/v1/permissions/` |
| Fleet management (`fleet`) | Enterprise | `fleet/` | `(dashboard)/fleet/`, `api/v1/fleet/`, `api/instances/pull/` |
| High availability (`high_availability`) | Enterprise | `high-availability/` | `(dashboard)/high-availability/`, `api/v1/high-availability/`, `api/v1/cluster/` |
| LDAP / Active Directory (`ldap`) | Enterprise | `ldap/` | `(dashboard)/ldap/`, `api/v1/ldap-directories/` |
| License keys (no feature: the key itself) | all | `licensing/` | `(dashboard)/license/`, `api/v1/license/` |
| API monetization (`api_monetization`) | Enterprise | `monetization/` | `(dashboard)/api-monetization/`, `api-portal/`, `api/monetization/`, `api/v1/monetization/` |
| Multi-tenancy (`multi_tenancy`) | MSP | `multi-tenancy/` | `(dashboard)/organizations/`, `(dashboard)/usage/`, `api/v1/organizations/`, `api/v1/usage-reports/` |
| SAML single sign-on (`sso_saml`) | Business | `saml/` | `(dashboard)/saml/`, `api/v1/saml-providers/` |
| SCIM provisioning (`scim`) | Enterprise | `scim/` | `(dashboard)/scim/`, `api/v1/scim/`, `scim/` (SCIM 2.0 at `/scim/v2`) |
| Enforced SSO (`sso_enforce`) | Business | `sso/` | `(dashboard)/sso/`, `api/v1/sso/` |
| White-label (`white_label`) | MSP | `white-label/` | `(dashboard)/branding/`, `api/v1/branding/`, `api/branding/` |
| Air-gapped installs and planned LTS (`air_gap`) | Enterprise | `scripts/airgap-bundle.sh` | none (`docs/air-gapped.md`, `docs/lts.md`) |

Layout of a module: route handlers in `<module>/routes/`, named after the URL below `/api/` (`/api/v1/monetization/plans/{id}` is `monetization/routes/v1/monetization/plans/[id].ts`, `/scim/v2/Users` is `scim/routes/scim/v2/Users.ts`); pages, client components and server actions in `<module>/ui/` (`ui/MonetizationPage.tsx`, `ui/actions.ts`); everything else at the top of the module.

A routing file in `app/` looks like this, and nothing else may be in it:

```ts
// SPDX-License-Identifier: MIT
// Routes to ee/monetization/routes/v1/monetization/plans.ts (Elastic License 2.0).
export { GET, POST } from "@/ee/monetization/routes/v1/monetization/plans";
```

Pages re-export `default` and `metadata` (or `generateMetadata`). Route segment config such as `export const dynamic = "force-dynamic"` stays in the routing file as a literal, because Next.js reads it from that file. Server actions are not routed: the components that call them import them from `ee/` directly.

### Paid sections on free pages

Free pages that show a paid section import its component from `ee/`; the page itself stays MIT:

| Free page | Paid section (in `ee/`) |
| --- | --- |
| Dashboard layout | Access review reminder (`access-reviews/ui/AccessReviewBanner.tsx`), organization switcher (`multi-tenancy/ui/OrganizationSwitcher.tsx`), branding (`white-label/ui/`) |
| Audit log | Export dialog and hash chain check (`audit/ui/AuditLogTools.tsx`, `audit/ui/actions.ts`), streaming strip (`audit/ui/StreamingStrip.tsx`) |
| Analytics | Questions to the AI analyst (`ai/questions/ui/AskPanel.tsx`) |
| Security events | WAF tuning suggestions (`ai/ui/TuningSuggestions.tsx`) |
| Certificate settings | Certificate storage (`high-availability/ui/CertificateStorageSection.tsx`) |
| Instance sync | Pull replicas (`fleet/ui/PullReplicasPanel.tsx`, `fleet/ui/PullAgentCard.tsx`) |
| Users and groups | Roles tab (`custom-roles/ui/RolesTabSection.tsx`, `custom-roles/ui/RolesTab.tsx`) |
| Proxy hosts and L4 hosts | Change approval notices (`approvals/ui/ProtectedChangeNotice.tsx`) |
| Sign-in page | LDAP and SAML sign-in (`ldap/ui/sign-in-client.ts`, `saml/ui/sign-in-client.ts`) |
| Sign-in and directories | Enforced SSO (`sso/ui/EnforcementSection.tsx`), SAML, LDAP and SCIM cards (`saml/ui/SamlSourceCard.tsx`, `ldap/ui/LdapSourceCard.tsx`, `scim/ui/ScimSourceCard.tsx`) |

Configuration export and import is free: its dialog on the Change history page is MIT (`src/components/config-transfer/TransferDialog.tsx`).

### Core hooks

Core code reads paid state or lets a paid feature take part through small hooks: organization scoping in the models, approval guards, the product name, the background jobs, sync. Every core file outside `app/` that imports `ee/` is listed in `CORE_EE_HOOKS` in `boundary.ts` with what it uses `ee/` for, so a reviewer sees when paid logic would land in core. Free pages and routes in `app/` call the same hooks.

### Headers

Every source file here starts with `// SPDX-License-Identifier: Elastic-2.0` (above a `"use client"` or `"use server"` directive, below a shebang). Every routing file in `app/` starts with `// SPDX-License-Identifier: MIT` and a comment naming the `ee/` file it routes to.
