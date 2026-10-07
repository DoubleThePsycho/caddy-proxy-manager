# Features in ee/

Documentation of the features whose code is in `ee/` (Elastic License 2.0). The other features are documented in [/documentation](../../documentation).

| Feature | Docs |
| --- | --- |
| Enforced SSO | [sso-enforcement.md](sso-enforcement.md) |
| SAML single sign-on | [sso-saml.md](sso-saml.md) |
| LDAP / Active Directory sign-in with group-to-role mapping | [ldap.md](ldap.md) |
| SCIM 2.0 provisioning (Microsoft Entra ID, Okta) | [scim.md](scim.md) |
| Custom roles | [custom-roles.md](custom-roles.md) |
| Access reviews: periodic access recertification with records | [access-reviews.md](access-reviews.md) |
| Audit streaming, export, retention, hash-chain verification | [audit-streaming.md](audit-streaming.md) |
| Alerting | [alerting.md](alerting.md) |
| Configuration history and rollback | [config-history.md](config-history.md) |
| Change approvals (four-eyes) and change windows | [change-approvals.md](change-approvals.md) |
| Compliance reports (access review, change log, certificate inventory, protection coverage) and NIS2 incident notification drafts | [compliance-reports.md](compliance-reports.md) |
| Scheduled backups to S3-compatible storage | [scheduled-backups.md](scheduled-backups.md) |
| AI analyst: alert explanations, daily digest, WAF tuning | [ai-analyst.md](ai-analyst.md) |
| Analytics questions in plain language (AI analyst), saved and added to compliance report schedules | [analytics-questions.md](analytics-questions.md) |
| API monetization: per-request billing, prepaid or postpaid through Stripe, and x402 pay-per-request | [api-monetization.md](api-monetization.md) |
| Fleet management: environments, promotion, canary rollout, drift detection, pull replicas | [fleet.md](fleet.md) |
| High availability: shared certificate storage for Caddy nodes, a dashboard cluster with automatic failover (Litestream), shared forward-auth sessions and API balances for web nodes on Redis/Valkey, and PostgreSQL replicas | [high-availability.md](high-availability.md) |
| Air-gapped installs: offline bundle | [air-gapped.md](air-gapped.md) |
| White-label: product name, logos, favicon, colours, sign-in texts, e-mail sender name | [white-label.md](white-label.md) |
