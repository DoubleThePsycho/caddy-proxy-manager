// SPDX-License-Identifier: Elastic-2.0
/**
 * Live control status: six checks of the running installation, each with
 * what was checked, the evidence that supports it and the NIS2 measure and
 * ISO/IEC 27001 control it can support. Like the reports, a status is
 * evidence for a control, not proof that the control is in place.
 *
 * - TLS on every host: every enabled proxy host redirects HTTP to HTTPS and
 *   has a valid certificate (imported, or obtained by Caddy and read from it
 *   with a TLS handshake, src/lib/managed-certificates.ts).
 * - MFA for administrators: every active administrator (built-in admin or an
 *   administrator-level custom role) who signs in with a password here has a
 *   second factor. Administrators who only sign in through single sign-on
 *   get their second factor from the identity provider, which is not
 *   verified here.
 * - Audit log integrity verified: the hash chain was verified (by hand, the
 *   API or a report schedule) in the last 31 days and was intact.
 * - Backups restored in a test: a successful test restore was recorded
 *   (POST /api/v1/compliance/restore-tests), or a backup was restored, in the
 *   last 90 days, and scheduled backups are set up.
 * - Access reviews completed: a review completed in the last 100 days and
 *   none overdue.
 * - WAF blocking on internet-facing hosts: every enabled proxy host has the
 *   WAF in blocking mode. The product cannot tell which hosts are reachable
 *   from the internet, so every enabled proxy host counts.
 *
 * Read-only; it reads only this installation.
 */
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { X509Certificate } from "node:crypto";
import { appDb } from "@/src/lib/db";
import {
  accessReviewCampaigns,
  accessReviewItems,
  auditEvents,
  backupDestinations,
  certificates,
  complianceReports,
  users,
} from "@/src/lib/db/schema";
import { getWafSettings } from "@/src/lib/settings";
import { listProxyHosts } from "@/src/lib/models/proxy-hosts";
import { canSignInWithPassword, listMfaAccountSummaries } from "@/src/lib/mfa";
import { getManagedCertificates, type ManagedCertificateReport } from "@/src/lib/managed-certificates";
import { listCustomRoleViews } from "@/ee/custom-roles/store";
import { latestSuccessfulRestoreTest } from "./restore-tests";
import { wafState } from "./reports/protection-coverage";
import { COMPLIANCE_STATEMENT, ISO27001_CONTROLS, NIS2_MEASURES, type IsoRef, type Nis2Ref } from "./controls";
import { REPORT_TYPE_LABELS, type ReportType } from "./types";
import { desc, first as dbFirst } from "@/src/lib/db/ops";

export const CONTROL_KEYS = ["tls", "mfa_admins", "audit_chain", "backup_restore", "access_reviews", "waf_blocking"] as const;
export type ControlKey = (typeof CONTROL_KEYS)[number];
export type ControlStatus = "met" | "attention" | "not_met" | "unknown";

export type ControlEvidence = { label: string; route: string; kind: "report" | "page" | "record" };

export type LiveControl = {
  key: ControlKey;
  title: string;
  status: ControlStatus;
  /** A short label for the status, e.g. "Met", "Due in 3 days", "Overdue". */
  statusLabel: string;
  /** What was checked and what was found, in plain sentences. */
  checked: string;
  evidence: ControlEvidence[];
  references: { nis2: { ref: string; title: string }; iso27001: { ref: string; title: string } };
  /** The figures behind the status. */
  facts: Record<string, unknown>;
};

export type ControlStatusView = {
  checkedAt: string;
  counts: Record<ControlStatus, number>;
  controls: LiveControl[];
  statement: string;
};

const DAY_MS = 24 * 60 * 60 * 1000;
export const CHAIN_VERIFICATION_MAX_AGE_DAYS = 31;
export const RESTORE_TEST_MAX_AGE_DAYS = 90;
export const ACCESS_REVIEW_MAX_AGE_DAYS = 100;
const CERTIFICATE_WARNING_DAYS = 14;
const MAX_NAMED = 5;

const REFERENCES: Record<ControlKey, { nis2: Nis2Ref; iso: IsoRef }> = {
  tls: { nis2: "Art. 21(2)(h)", iso: "A.8.24" },
  mfa_admins: { nis2: "Art. 21(2)(j)", iso: "A.8.5" },
  audit_chain: { nis2: "Art. 21(2)(b)", iso: "A.8.15" },
  backup_restore: { nis2: "Art. 21(2)(c)", iso: "A.8.13" },
  access_reviews: { nis2: "Art. 21(2)(i)", iso: "A.5.18" },
  waf_blocking: { nis2: "Art. 21(2)(e)", iso: "A.8.20" },
};

const TITLES: Record<ControlKey, string> = {
  tls: "TLS on every host",
  mfa_admins: "MFA for administrators",
  audit_chain: "Audit log integrity verified",
  backup_restore: "Backups restored in a test",
  access_reviews: "Access reviews completed",
  waf_blocking: "WAF blocking on internet-facing hosts",
};

const STATUS_LABELS: Record<ControlStatus, string> = { met: "Met", attention: "Needs attention", not_met: "Not met", unknown: "Unknown" };

function control(key: ControlKey, status: ControlStatus, checked: string, evidence: ControlEvidence[], facts: Record<string, unknown>, statusLabel?: string): LiveControl {
  const refs = REFERENCES[key];
  return {
    key,
    title: TITLES[key],
    status,
    statusLabel: statusLabel ?? STATUS_LABELS[status],
    checked,
    evidence,
    references: { nis2: { ref: refs.nis2, title: NIS2_MEASURES[refs.nis2] }, iso27001: { ref: refs.iso, title: ISO27001_CONTROLS[refs.iso] } },
    facts,
  };
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

function listNames(names: string[]): string {
  const shown = names.slice(0, MAX_NAMED).join(", ");
  return names.length > MAX_NAMED ? `${shown} and ${names.length - MAX_NAMED} more` : shown;
}

function daysAgo(iso: string, now: Date): number {
  return Math.floor((now.getTime() - Date.parse(iso)) / DAY_MS);
}

function monthLabel(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", { month: "short", year: "numeric", timeZone: "UTC" });
}

/** The newest report of each type, as evidence. */
async function latestReports(types: ReportType[]): Promise<ControlEvidence[]> {
  const evidence: ControlEvidence[] = [];
  for (const type of types) {
    const row = await dbFirst(appDb
      .select({ id: complianceReports.id, periodTo: complianceReports.periodTo })
      .from(complianceReports)
      .where(eq(complianceReports.type, type))
      .orderBy(desc(complianceReports.generatedAt), desc(complianceReports.id))
      .limit(1));
    if (row) evidence.push({ label: `${REPORT_TYPE_LABELS[type]}, ${monthLabel(row.periodTo)}`, route: `/compliance/reports/${row.id}`, kind: "report" as const });
  }
  return evidence;
}

// ── The checks ────────────────────────────────────────────────────────

export type ControlDependencies = { managedCertificates: () => Promise<ManagedCertificateReport> };

const defaultDependencies: ControlDependencies = {
  managedCertificates: () => getManagedCertificates({ cachedOnly: true }),
};

async function tlsControl(now: Date, deps: ControlDependencies): Promise<LiveControl> {
  const hosts = (await listProxyHosts()).filter((host) => host.enabled);
  const evidence = await latestReports(["protection_coverage", "certificate_inventory"]);
  if (hosts.length === 0) return control("tls", "unknown", "There are no enabled proxy hosts to check.", evidence, { enabledHosts: 0 }, "No hosts");
  const noRedirect = hosts.filter((host) => !host.sslForced).map((host) => host.name);
  const importedIds = [...new Set(hosts.map((host) => host.certificateId).filter((id): id is number => id !== null))];
  const imported = importedIds.length === 0 ? [] : await appDb.select({ id: certificates.id, name: certificates.name, type: certificates.type, pem: certificates.certificatePem }).from(certificates).where(inArray(certificates.id, importedIds));
  const expired: string[] = [];
  const expiring: string[] = [];
  let minDays: number | null = null;
  const note = (name: string, validTo: Date) => {
    const days = Math.floor((validTo.getTime() - now.getTime()) / DAY_MS);
    minDays = minDays === null ? days : Math.min(minDays, days);
    if (days < 0) expired.push(name);
    else if (days < CERTIFICATE_WARNING_DAYS) expiring.push(name);
  };
  for (const cert of imported) {
    if (cert.type !== "imported" || !cert.pem) continue;
    try {
      note(cert.name, new Date(new X509Certificate(cert.pem).validTo));
    } catch {
      // An unreadable certificate is listed by the certificate inventory report.
    }
  }
  const managed: ManagedCertificateReport | null = await deps.managedCertificates().catch(() => null);
  const missing: string[] = [];
  const renewalOverdue: string[] = [];
  for (const status of managed?.certificates ?? []) {
    if (status.state === "missing" || status.state === "mismatch") missing.push(status.domain);
    else if (status.validTo) {
      note(status.domain, new Date(status.validTo));
      if (status.state === "renewal_overdue") renewalOverdue.push(status.domain);
    }
  }
  const managedUnchecked = !managed || !managed.available;
  const facts = {
    enabledHosts: hosts.length,
    withoutHttpsRedirect: noRedirect,
    expired,
    expiringWithinDays: CERTIFICATE_WARNING_DAYS,
    expiring,
    renewalOverdue,
    missing,
    shortestDaysLeft: minDays,
    caddyCertificatesChecked: !managedUnchecked,
  };
  const problems: string[] = [];
  if (noRedirect.length > 0) problems.push(`${plural(noRedirect.length, "host")} do${noRedirect.length === 1 ? "es" : ""} not redirect plain HTTP to HTTPS: ${listNames(noRedirect)}.`);
  if (expired.length > 0) problems.push(`Expired: ${listNames(expired)}.`);
  if (missing.length > 0) problems.push(`Caddy serves no valid certificate for ${listNames(missing)}.`);
  if (problems.length > 0) return control("tls", "not_met", problems.join(" "), evidence, facts);
  const warnings: string[] = [];
  if (renewalOverdue.length > 0) warnings.push(`The renewal of ${listNames(renewalOverdue)} is overdue.`);
  if (expiring.length > 0) warnings.push(`Expiring within ${CERTIFICATE_WARNING_DAYS} days: ${listNames(expiring)}.`);
  if (managedUnchecked) warnings.push(managed?.reason ?? "The certificates Caddy manages could not be checked.");
  const base = `All ${plural(hosts.length, "enabled host")} serve HTTPS and redirect plain HTTP to it.`;
  if (warnings.length > 0) return control("tls", "attention", `${base} ${warnings.join(" ")}`, evidence, facts);
  return control("tls", "met", `${base}${minDays !== null ? ` Every certificate has ${minDays} days or more left.` : ""}`, evidence, facts);
}

async function mfaControl(now: Date): Promise<LiveControl> {
  const roles = new Map((await listCustomRoleViews(appDb)).map((role) => [role.id, role]));
  const accounts = await appDb.select({ id: users.id, email: users.email, name: users.name, username: users.username, role: users.role, customRoleId: users.customRoleId, status: users.status }).from(users);
  const summaries = new Map((await listMfaAccountSummaries(now)).map((summary) => [summary.id, summary]));
  const label = (row: (typeof accounts)[number]) => row.username ?? row.name ?? row.email;
  const admins = accounts.filter((row) => row.status === "active" && ((row.role === "admin" && row.customRoleId === null) || (row.customRoleId !== null && roles.get(row.customRoleId)?.adminLevel === true)));
  const withPassword: typeof admins = [];
  for (const row of admins) if (await canSignInWithPassword(appDb, row.id)) withPassword.push(row);
  const ssoOnly = admins.filter((row) => !withPassword.includes(row)).map(label);
  const withoutMfa = withPassword.filter((row) => !summaries.get(row.id)?.enabled).map(label);
  const active = accounts.filter((row) => row.status === "active");
  const enrolled = active.filter((row) => summaries.get(row.id)?.enabled).length;
  const evidence = [...await latestReports(["access_review"]), { label: "Users", route: "/users", kind: "page" as const }];
  const facts = { administrators: admins.length, administratorsWithoutMfa: withoutMfa, administratorsSsoOnly: ssoOnly, activeAccounts: active.length, accountsWithMfa: enrolled };
  const coverage = `${enrolled} of ${plural(active.length, "active account")} use${active.length === 1 ? "s" : ""} MFA.`;
  if (admins.length === 0) return control("mfa_admins", "unknown", `There is no active administrator. ${coverage}`, evidence, facts, "No administrators");
  if (withoutMfa.length > 0) {
    return control("mfa_admins", "not_met", `${plural(withoutMfa.length, "administrator")} sign${withoutMfa.length === 1 ? "s" : ""} in with a password and no second factor: ${listNames(withoutMfa)}. ${coverage}`, evidence, facts);
  }
  if (ssoOnly.length > 0) {
    return control(
      "mfa_admins",
      "attention",
      `Every administrator who signs in with a password here uses MFA. ${listNames(ssoOnly)} sign${ssoOnly.length === 1 ? "s" : ""} in through single sign-on only, so the identity provider decides their second factor; check it there. ${coverage}`,
      evidence,
      facts
    );
  }
  return control("mfa_admins", "met", `${admins.length === 1 ? "The administrator signs" : `All ${admins.length} administrators sign`} in with MFA. ${coverage}`, evidence, facts);
}

async function chainControl(now: Date): Promise<LiveControl> {
  const row = await dbFirst(appDb
    .select({ createdAt: auditEvents.createdAt, data: auditEvents.data })
    .from(auditEvents)
    .where(eq(auditEvents.action, "audit_log_verified"))
    .orderBy(desc(auditEvents.id))
    .limit(1));
  const evidence = [...await latestReports(["change_log"]), { label: "Audit log", route: "/audit-log", kind: "page" as const }];
  if (!row) {
    return control("audit_chain", "attention", "The audit log's hash chain has not been verified yet. Verify it on the audit log page, or let a report schedule do it.", evidence, { verifiedAt: null }, "Not verified");
  }
  type Recorded = { ok?: unknown; checked?: unknown; headHash?: unknown; firstMismatchId?: unknown };
  const data: Recorded = (() => {
    try {
      return row.data ? (JSON.parse(row.data) as Recorded) : {};
    } catch {
      return {};
    }
  })();
  const age = daysAgo(row.createdAt, now);
  const facts = { verifiedAt: row.createdAt, ok: data.ok === true, checked: data.checked ?? null, headHash: typeof data.headHash === "string" ? data.headHash : null, daysAgo: age };
  const head = typeof data.headHash === "string" ? ` Head hash ${data.headHash.slice(0, 8)}…${data.headHash.slice(-8)}.` : "";
  if (data.ok !== true) {
    return control("audit_chain", "not_met", `The last verification, on ${row.createdAt.slice(0, 10)}, found a mismatch${typeof data.firstMismatchId === "number" ? ` at event #${data.firstMismatchId}` : ""}: events from there on may have been changed, removed or inserted.`, evidence, facts);
  }
  const checked = typeof data.checked === "number" ? `${data.checked} events` : "The events";
  if (age > CHAIN_VERIFICATION_MAX_AGE_DAYS) {
    return control("audit_chain", "attention", `Hash chain intact when last verified on ${row.createdAt.slice(0, 10)}, ${age} days ago; the target is every ${CHAIN_VERIFICATION_MAX_AGE_DAYS} days.${head}`, evidence, facts, "Overdue");
  }
  return control("audit_chain", "met", `Hash chain intact: ${checked} checked on ${row.createdAt.slice(0, 10)}, no mismatch.${head}`, evidence, facts);
}

async function backupControl(now: Date): Promise<LiveControl> {
  const destinations = await appDb
    .select({ id: backupDestinations.id, name: backupDestinations.name, lastSuccessAt: backupDestinations.lastSuccessAt, lastStatus: backupDestinations.lastStatus })
    .from(backupDestinations)
    .where(eq(backupDestinations.enabled, true))
    .orderBy(backupDestinations.id);
  const test = await latestSuccessfulRestoreTest();
  const restored = await dbFirst(appDb
    .select({ createdAt: auditEvents.createdAt })
    .from(auditEvents)
    .where(eq(auditEvents.action, "config_backup_restored"))
    .orderBy(desc(auditEvents.id))
    .limit(1));
  const candidates = [test ? { at: test.testedAt, what: "test restore" } : null, restored ? { at: restored.createdAt, what: "restore from a backup" } : null].filter(
    (item): item is { at: string; what: string } => item !== null
  );
  const latest = candidates.sort((a, b) => b.at.localeCompare(a.at))[0] ?? null;
  const lastBackup = destinations.map((row) => row.lastSuccessAt).filter((at): at is string => at !== null).sort().pop() ?? null;
  const failing = destinations.filter((row) => row.lastStatus === "failed").map((row) => row.name);
  const evidence: ControlEvidence[] = [{ label: "Backup runs", route: "/backups", kind: "page" }];
  if (test) evidence.push({ label: `Test restore, ${test.testedAt.slice(0, 10)}`, route: "/compliance", kind: "record" });
  const facts = { destinations: destinations.length, lastBackupAt: lastBackup, failingDestinations: failing, lastRestoreTestAt: latest?.at ?? null, maxAgeDays: RESTORE_TEST_MAX_AGE_DAYS };
  const backups = destinations.length === 0
    ? "No scheduled backup destination is enabled."
    : `${plural(destinations.length, "backup destination")} enabled${lastBackup ? `, the last successful backup on ${lastBackup.slice(0, 10)}` : ", no successful backup yet"}${failing.length > 0 ? `; failing: ${listNames(failing)}` : ""}.`;
  if (!latest) return control("backup_restore", "not_met", `${backups} No test restore has been recorded.`, evidence, facts, "No test restore");
  const age = daysAgo(latest.at, now);
  if (age > RESTORE_TEST_MAX_AGE_DAYS) {
    return control("backup_restore", "attention", `${backups} The last ${latest.what} was on ${latest.at.slice(0, 10)}, ${age} days ago; the target is every ${RESTORE_TEST_MAX_AGE_DAYS} days.`, evidence, facts, "Overdue");
  }
  if (destinations.length === 0 || failing.length > 0) return control("backup_restore", "attention", `${backups} The last ${latest.what} was on ${latest.at.slice(0, 10)}.`, evidence, facts);
  return control("backup_restore", "met", `${backups} The last ${latest.what} succeeded on ${latest.at.slice(0, 10)}, ${age} days ago.`, evidence, facts);
}

async function accessReviewControl(now: Date): Promise<LiveControl> {
  const open = await appDb.select({ id: accessReviewCampaigns.id, name: accessReviewCampaigns.name, dueAt: accessReviewCampaigns.dueAt }).from(accessReviewCampaigns).where(eq(accessReviewCampaigns.status, "open")).orderBy(accessReviewCampaigns.id);
  const completed = await dbFirst(appDb
    .select({ id: accessReviewCampaigns.id, name: accessReviewCampaigns.name, completedAt: accessReviewCampaigns.completedAt })
    .from(accessReviewCampaigns)
    .where(and(eq(accessReviewCampaigns.status, "completed"), isNotNull(accessReviewCampaigns.completedAt)))
    .orderBy(desc(accessReviewCampaigns.completedAt), desc(accessReviewCampaigns.id))
    .limit(1));
  const evidence: ControlEvidence[] = [];
  const openFacts: Array<{ id: number; name: string; dueAt: string; items: number; decided: number }> = [];
  for (const campaign of open) {
    const items = await appDb.select({ confirmedAt: accessReviewItems.confirmedAt, outcome: accessReviewItems.outcome }).from(accessReviewItems).where(eq(accessReviewItems.campaignId, campaign.id));
    const decided = items.filter((item) => item.confirmedAt !== null || item.outcome !== null).length;
    evidence.push({ label: campaign.name, route: `/access-reviews/${campaign.id}`, kind: "record" });
    openFacts.push({ id: campaign.id, name: campaign.name, dueAt: campaign.dueAt, items: items.length, decided });
  }
  if (completed) evidence.push({ label: `${completed.name} record`, route: `/access-reviews/${completed.id}`, kind: "record" });
  const facts = { open: openFacts, lastCompletedAt: completed?.completedAt ?? null, maxAgeDays: ACCESS_REVIEW_MAX_AGE_DAYS };
  const lastText = completed ? `The last review, "${completed.name}", was completed on ${completed.completedAt!.slice(0, 10)}.` : "No review has been completed yet.";
  const overdue = openFacts.filter((campaign) => Date.parse(campaign.dueAt) < now.getTime() && campaign.decided < campaign.items);
  if (overdue.length > 0) {
    const first = overdue[0];
    return control("access_reviews", "not_met", `"${first.name}" was due on ${first.dueAt.slice(0, 10)} with ${first.items - first.decided} of ${first.items} items still undecided. ${lastText}`, evidence, facts, "Overdue");
  }
  const recent = completed && daysAgo(completed.completedAt!, now) <= ACCESS_REVIEW_MAX_AGE_DAYS;
  const soon = openFacts.filter((campaign) => Date.parse(campaign.dueAt) - now.getTime() <= 7 * DAY_MS).sort((a, b) => a.dueAt.localeCompare(b.dueAt))[0];
  if (soon) {
    const days = Math.max(0, Math.ceil((Date.parse(soon.dueAt) - now.getTime()) / DAY_MS));
    return control("access_reviews", "attention", `"${soon.name}" is open: ${soon.decided} of ${soon.items} items decided, due ${soon.dueAt.slice(0, 10)}. ${lastText}`, evidence, facts, days === 0 ? "Due today" : `Due in ${plural(days, "day")}`);
  }
  if (!recent) {
    return openFacts.length > 0
      ? control("access_reviews", "attention", `"${openFacts[0].name}" is open, due ${openFacts[0].dueAt.slice(0, 10)}. ${lastText}`, evidence, facts, "In progress")
      : control("access_reviews", "not_met", `No access review in the last ${ACCESS_REVIEW_MAX_AGE_DAYS} days. ${lastText}`, evidence, facts, "No recent review");
  }
  return control("access_reviews", "met", `${lastText}${openFacts.length > 0 ? ` "${openFacts[0].name}" is open, due ${openFacts[0].dueAt.slice(0, 10)}.` : ""}`, evidence, facts);
}

async function wafControl(): Promise<LiveControl> {
  const [global, hosts] = await Promise.all([getWafSettings(), listProxyHosts()]);
  const enabled = hosts.filter((host) => host.enabled);
  const evidence = [...await latestReports(["protection_coverage"]), { label: "Security events", route: "/waf", kind: "page" as const }];
  if (enabled.length === 0) return control("waf_blocking", "unknown", "There are no enabled proxy hosts to check.", evidence, { enabledHosts: 0 }, "No hosts");
  const states = enabled.map((host) => ({ host, state: wafState(global, host) }));
  const detectOnly = states.filter((entry) => entry.state.mode === "detection only").map((entry) => entry.host.name);
  const off = states.filter((entry) => entry.state.mode === "off").map((entry) => entry.host.name);
  const blocking = enabled.length - detectOnly.length - off.length;
  const facts = { enabledHosts: enabled.length, blocking, detectionOnly: detectOnly, off };
  if (detectOnly.length === 0 && off.length === 0) {
    return control("waf_blocking", "met", `All ${plural(enabled.length, "enabled host")} block attacks with the WAF. Every enabled proxy host counts as internet-facing.`, evidence, facts);
  }
  const parts = [`${blocking} of ${plural(enabled.length, "enabled host")} block attacks.`];
  if (detectOnly.length > 0) parts.push(`Only detecting: ${listNames(detectOnly)}.`);
  if (off.length > 0) parts.push(`Without the WAF: ${listNames(off)}.`);
  return control("waf_blocking", "not_met", parts.join(" "), evidence, facts);
}

/** Every live control with its status. */
export async function getControlStatus(now: Date = new Date(), deps: ControlDependencies = defaultDependencies): Promise<ControlStatusView> {
  const controls = [await tlsControl(now, deps), await mfaControl(now), await chainControl(now), await backupControl(now), await accessReviewControl(now), await wafControl()];
  const counts: Record<ControlStatus, number> = { met: 0, attention: 0, not_met: 0, unknown: 0 };
  for (const item of controls) counts[item.status] += 1;
  return { checkedAt: now.toISOString(), counts, controls, statement: COMPLIANCE_STATEMENT };
}
