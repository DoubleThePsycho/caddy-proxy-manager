# Paid features

How licensing works: [../README.md](../README.md). Buying, trials, installing keys and automatic updates: [licenses.md](licenses.md). Free-feature docs live in [/documentation](../../documentation).

| Feature | Edition | Docs |
| --- | --- | --- |
| Enforced SSO | Business | [sso-enforcement.md](sso-enforcement.md) |
| SAML single sign-on | Business | [sso-saml.md](sso-saml.md) |
| LDAP / Active Directory sign-in with group-to-role mapping | Enterprise | [ldap.md](ldap.md) |
| Audit streaming, export, retention, hash-chain verification | Business | [audit-streaming.md](audit-streaming.md) |
| Alerting | Homelab (e-mail certificate alerts are free) | [alerting.md](alerting.md) |
| Configuration history and rollback | Homelab | [config-history.md](config-history.md) |
| Scheduled backups to S3-compatible storage | Business | [scheduled-backups.md](scheduled-backups.md) |
| AI analyst: alert explanations, daily digest, WAF tuning | Homelab | [ai-analyst.md](ai-analyst.md) |
| Analytics questions in plain language (AI analyst), saved and added to compliance report schedules | Homelab (schedules: Enterprise) | [analytics-questions.md](analytics-questions.md) |
| API monetization: per-request billing, prepaid or postpaid through Stripe, and x402 pay-per-request | Enterprise | [api-monetization.md](api-monetization.md) |
| Fleet management: environments, promotion, canary rollout, drift detection, pull replicas | Enterprise | [fleet.md](fleet.md) |
| High availability: shared certificate storage for Caddy nodes (phase 1), a dashboard cluster with automatic failover (Litestream, phase 2) and shared forward-auth sessions and API balances for web nodes (phase 3), on Redis/Valkey | Enterprise | [high-availability.md](high-availability.md) |
| Air-gapped installs: offline bundle | Enterprise | [air-gapped.md](air-gapped.md) |
| Long-term-support release lines (24 months), planned: none announced yet | Enterprise | [lts.md](lts.md) |
| White-label: product name, logos, favicon, colours, sign-in texts, e-mail sender name | Enterprise | [white-label.md](white-label.md) |
| Change approvals (four-eyes) and change windows | Enterprise | [change-approvals.md](change-approvals.md) |
| Compliance reports (access review, change log, certificate inventory, protection coverage) and NIS2 incident notification drafts | Enterprise | [compliance-reports.md](compliance-reports.md) |
| SCIM 2.0 provisioning (Microsoft Entra ID, Okta) | Enterprise | [scim.md](scim.md) |
| Access reviews: periodic access recertification with records | Enterprise | [access-reviews.md](access-reviews.md) |

Every feature follows the same rule: a license is needed to set it up, enable it or change it; deleting or disabling it never needs one, and nothing that is already configured stops working when a license lapses.
