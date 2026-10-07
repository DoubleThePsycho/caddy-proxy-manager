# ee/ (Elastic License 2.0)

Code in this directory is under the [Elastic License 2.0](LICENSE), not MIT. You may use, self-host and modify it, but you may not offer it to others as a hosted or managed service. Everything outside `ee/` is [MIT](../LICENSE).

Next.js only finds pages and API routes under `app/`, so each page or route implemented here keeps a file there that only re-exports it from `ee/` and contains no code under the Elastic License 2.0 (see [Where ee/ code lives](#where-ee-code-lives)).

## Where ee/ code lives

Every feature implemented in `ee/`, its module and the files in `app/` that route to it. The routing files are listed in `boundary.ts`, and `tests/unit/license-boundary.test.ts` fails when one of them holds anything but a shim.

| Feature | `ee/` module | Routed to from `app/` |
| --- | --- | --- |
| Access reviews | `access-reviews/` | `(dashboard)/access-reviews/`, `(dashboard)/my-reviews/`, `api/v1/access-review-assignments/`, `api/v1/access-review-schedules/`, `api/v1/access-reviews/` |
| AI analyst | `ai/` | `api/v1/ai/`, `api/v1/analytics/questions/`, `api/v1/waf/tuning-suggestions/` |
| Alerting | `alerting/` | `(dashboard)/alerts/`, `api/v1/alert-channels/`, `api/v1/alert-events/`, `api/v1/alert-rules/`, `api/v1/alert-silences/` |
| Change approvals | `approvals/` | `(dashboard)/approvals/`, `api/v1/approval-policies/`, `api/v1/change-requests/` |
| Audit streaming and export | `audit/` | `(dashboard)/audit-log/streaming/`, `api/v1/audit-sinks/`, `api/v1/audit-log/export/`, `api/v1/audit-log/retention/`, `api/v1/audit-log/verify/` |
| Scheduled backups | `backups/` | `(dashboard)/backups/`, `api/v1/backup-destinations/`, `api/v1/backup-runs/` |
| Compliance reports | `compliance/` | `(dashboard)/compliance/`, `print/compliance/`, `api/v1/compliance/` |
| Configuration history and rollback | `config-history/` | `(dashboard)/history/`, `api/v1/config-history/` |
| Custom roles | `custom-roles/` | `api/v1/roles/`, `api/v1/permissions/` |
| Fleet management | `fleet/` | `(dashboard)/fleet/`, `api/v1/fleet/`, `api/instances/pull/` |
| High availability | `high-availability/` | `(dashboard)/high-availability/`, `api/v1/high-availability/`, `api/v1/cluster/` |
| LDAP / Active Directory | `ldap/` | `(dashboard)/ldap/`, `api/v1/ldap-directories/` |
| API monetization | `monetization/` | `(dashboard)/api-monetization/`, `api-portal/`, `api/monetization/`, `api/v1/monetization/` |
| SAML single sign-on | `saml/` | `(dashboard)/saml/`, `api/v1/saml-providers/` |
| SCIM provisioning | `scim/` | `(dashboard)/scim/`, `api/v1/scim/`, `scim/` (SCIM 2.0 at `/scim/v2`) |
| Enforced SSO | `sso/` | `(dashboard)/sso/`, `api/v1/sso/` |
| White-label | `white-label/` | `(dashboard)/branding/`, `api/v1/branding/`, `api/branding/` |
| Air-gapped installs | `scripts/airgap-bundle.sh` | none (`docs/air-gapped.md`) |

Layout of a module: route handlers in `<module>/routes/`, named after the URL below `/api/` (`/api/v1/monetization/plans/{id}` is `monetization/routes/v1/monetization/plans/[id].ts`, `/scim/v2/Users` is `scim/routes/scim/v2/Users.ts`); pages, client components and server actions in `<module>/ui/` (`ui/MonetizationPage.tsx`, `ui/actions.ts`); everything else at the top of the module.

A routing file in `app/` looks like this, and nothing else may be in it:

```ts
// SPDX-License-Identifier: MIT
// Routes to ee/monetization/routes/v1/monetization/plans.ts (Elastic License 2.0).
export { GET, POST } from "@/ee/monetization/routes/v1/monetization/plans";
```

Pages re-export `default` and `metadata` (or `generateMetadata`). Route segment config such as `export const dynamic = "force-dynamic"` stays in the routing file as a literal, because Next.js reads it from that file. Server actions are not routed: the components that call them import them from `ee/` directly.

### ee/ sections on MIT pages

MIT pages that show a section implemented in `ee/` import its component from `ee/`; the page itself stays MIT:

| MIT page | Section (in `ee/`) |
| --- | --- |
| Dashboard layout | Access review reminder (`access-reviews/ui/AccessReviewBanner.tsx`), branding (`white-label/ui/`) |
| Audit log | Export dialog and hash chain check (`audit/ui/AuditLogTools.tsx`, `audit/ui/actions.ts`), streaming strip (`audit/ui/StreamingStrip.tsx`) |
| Analytics | Questions to the AI analyst (`ai/questions/ui/AskPanel.tsx`) |
| Security events | WAF tuning suggestions (`ai/ui/TuningSuggestions.tsx`) |
| Certificate settings | Certificate storage (`high-availability/ui/CertificateStorageSection.tsx`) |
| Instance sync | Pull replicas (`fleet/ui/PullReplicasPanel.tsx`, `fleet/ui/PullAgentCard.tsx`) |
| Users and groups | Roles tab (`custom-roles/ui/RolesTabSection.tsx`, `custom-roles/ui/RolesTab.tsx`) |
| Proxy hosts and L4 hosts | Change approval notices (`approvals/ui/ProtectedChangeNotice.tsx`) |
| Sign-in page | LDAP and SAML sign-in (`ldap/ui/sign-in-client.ts`, `saml/ui/sign-in-client.ts`) |
| Sign-in and directories | Enforced SSO (`sso/ui/EnforcementSection.tsx`), SAML, LDAP and SCIM cards (`saml/ui/SamlSourceCard.tsx`, `ldap/ui/LdapSourceCard.tsx`, `scim/ui/ScimSourceCard.tsx`) |

Configuration export and import is MIT: its dialog on the Change history page is `src/components/config-transfer/TransferDialog.tsx`.

### Core hooks

Core code reads `ee/` state or lets an `ee/` feature take part through small hooks: custom roles' permissions, approval guards, the product name, the background jobs, sync. Every core file outside `app/` that imports `ee/` is listed in `CORE_EE_HOOKS` in `boundary.ts` with what it uses `ee/` for, so a reviewer sees when `ee/` logic would land in core. MIT pages and routes in `app/` call the same hooks.

### Headers

Every source file here starts with `// SPDX-License-Identifier: Elastic-2.0` (above a `"use client"` or `"use server"` directive, below a shebang). Every routing file in `app/` starts with `// SPDX-License-Identifier: MIT` and a comment naming the `ee/` file it routes to.
