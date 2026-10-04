// SPDX-License-Identifier: Elastic-2.0
/**
 * Types and constants of audit streaming that the dashboard's client
 * components share with the server. No Node.js imports here.
 */

export const AUDIT_SINK_TYPES = ["webhook", "syslog", "splunk_hec"] as const;
export type AuditSinkType = (typeof AUDIT_SINK_TYPES)[number];

export const AUDIT_SINK_TYPE_LABELS: Record<AuditSinkType, string> = {
  webhook: "Webhook",
  syslog: "Syslog",
  splunk_hec: "Splunk HEC",
};

export const SYSLOG_PROTOCOLS = ["udp", "tcp", "tls"] as const;
export type SyslogProtocol = (typeof SYSLOG_PROTOCOLS)[number];

export const SYSLOG_DEFAULT_PORTS: Record<SyslogProtocol, number> = { udp: 514, tcp: 514, tls: 6514 };

/** RFC 5424 facility 13, "log audit". */
export const SYSLOG_DEFAULT_FACILITY = 13;

export type WebhookSinkConfig = { url: string };

export type SplunkHecSinkConfig = {
  /** Base URL of the HEC endpoint, e.g. https://splunk.example.com:8088 */
  url: string;
  index: string | null;
};

export type SyslogSinkConfig = {
  host: string;
  port: number;
  protocol: SyslogProtocol;
  facility: number;
  /** PEM CA bundle that signs the receiver's certificate (TLS only); system roots when null. */
  caPem: string | null;
};

export type AuditSinkConfig = WebhookSinkConfig | SplunkHecSinkConfig | SyslogSinkConfig;

/** What the API and the dashboard see of a sink. Secrets are never included. */
export type AuditSinkView = {
  id: number;
  name: string;
  type: AuditSinkType;
  enabled: boolean;
  config: AuditSinkConfig;
  /** Whether a webhook signing secret or HEC token is stored. */
  hasSecret: boolean;
  /** Highest audit event id delivered. */
  lastDeliveredId: number;
  /** Audit events recorded after lastDeliveredId. */
  pendingEvents: number;
  /** When the oldest event still waiting for this sink was recorded (its lag); null when nothing waits. */
  oldestPendingAt: string | null;
  lastDeliveryAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  consecutiveFailures: number;
  nextAttemptAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AuditRetentionView = {
  /** Events older than this many days are deleted daily; 0 keeps them forever. */
  days: number;
  lastRunAt: string | null;
  lastDeleted: number | null;
};

export type AuditVerification = {
  ok: boolean;
  /** Chained events checked (up to and including the first mismatch). */
  checked: number;
  firstMismatchId: number | null;
  /** Why firstMismatchId failed. */
  reason: string | null;
  /** createdAt of the oldest remaining chained event, where verification starts. */
  anchoredAt: string | null;
  anchorId: number | null;
  /**
   * prevHash of that event, trusted as the starting point: retention deletes
   * older events. Null when the chain starts there.
   */
  anchorHash: string | null;
  /** Newest chained event; compare headHash with a streamed or exported copy. */
  headId: number | null;
  headHash: string | null;
  /** Events recorded before the hash chain existed; not covered. */
  unchainedEvents: number;
  verifiedAt: string;
};

export type AuditSinkTestResult = { ok: boolean; error: string | null; durationMs: number };
