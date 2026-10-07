// SPDX-License-Identifier: Elastic-2.0
/**
 * How the change log groups audit events: the dashboard area each entity type
 * belongs to, and which actions are sign-ins or other events that do not
 * change anything (exports, tests, verifications, report generation).
 */
import { NON_CHANGE_AUDIT_ACTIONS } from "@/ee/ai/digest-data";

/** Sign-in and second-factor events (successful or not). */
export const SIGN_IN_ACTIONS: readonly string[] = [
  "login_success",
  "signin_existing",
  "auto_link",
  "account_linked",
  "require_manual_link",
  "oauth_link_rate_limited",
  "oauth_link_password_failed",
  "sso_enforced_sign_in_refused",
  "forward_auth_login",
  "forward_auth_login_failed",
  "forward_auth_access_denied",
  "mfa_verification_failed",
  "mfa_backup_code_used",
];

/** Compliance actions that record reading or drafting, not configuration changes. */
export const COMPLIANCE_NON_CHANGE_ACTIONS: readonly string[] = [
  "compliance_report_generated",
  "compliance_report_deleted",
  "compliance_incident_created",
  "compliance_incident_updated",
  "compliance_incident_drafted",
  "compliance_incident_facts_refreshed",
  "compliance_incident_deleted",
];

const NON_CHANGE = new Set<string>([...NON_CHANGE_AUDIT_ACTIONS, ...COMPLIANCE_NON_CHANGE_ACTIONS]);
const SIGN_IN = new Set<string>(SIGN_IN_ACTIONS);

export type AuditEventKind = "change" | "sign-in" | "other";

export function classifyAuditAction(action: string): AuditEventKind {
  if (SIGN_IN.has(action)) return "sign-in";
  // "create_new" is a sign-in that created the account; it is a change.
  if (action !== "create_new" && NON_CHANGE.has(action)) return "other";
  return "change";
}

const ENTITY_AREAS: Record<string, string> = {
  proxy_host: "Proxy hosts",
  forward_auth_access: "Proxy hosts",
  mtls_access_rule: "Proxy hosts",
  l4_proxy_host: "L4 proxy hosts",
  certificate: "Certificates and mTLS",
  ca_certificate: "Certificates and mTLS",
  issued_client_certificate: "Certificates and mTLS",
  mtls_role: "Certificates and mTLS",
  mtls_certificate_role: "Certificates and mTLS",
  access_list: "Access lists",
  access_list_entry: "Access lists",
  access_list_rule: "Access lists",
  blocked_source: "Access lists",
  user: "Users and roles",
  custom_role: "Users and roles",
  api_token: "Users and roles",
  session: "Sign-in",
  group: "Forward-auth groups",
  group_member: "Forward-auth groups",
  setting: "Settings",
  settings: "Settings",
  certificate_storage: "Settings",
  waf_tuning_suggestion: "WAF",
  waf_exclusion: "WAF",
  waf_settings: "WAF",
  instance: "Instances",
  oauth_provider: "Authentication (SSO and MFA)",
  sso_enforcement: "Authentication (SSO and MFA)",
  configuration: "Configuration, history and backups",
  config_snapshot: "Configuration, history and backups",
  config_history: "Configuration, history and backups",
  backup_destination: "Configuration, history and backups",
  audit_log: "Audit log",
  audit_sink: "Audit log",
  alert_channel: "Alerts",
  alert_rule: "Alerts",
  alert_silence: "Alerts",
  ai_settings: "AI analyst",
  ai_digest: "AI analyst",
  analytics_question: "AI analyst",
  compliance_report: "Compliance",
  compliance_incident: "Compliance",
};

export function auditArea(entityType: string): string {
  if (ENTITY_AREAS[entityType]) return ENTITY_AREAS[entityType];
  if (entityType.startsWith("monetization_")) return "API monetization";
  return entityType || "Other";
}
