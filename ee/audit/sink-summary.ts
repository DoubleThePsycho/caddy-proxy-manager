// SPDX-License-Identifier: Elastic-2.0
/**
 * The audit sinks as the audit log page shows them (ee/audit/ui/sink-view.ts):
 * never a secret, URLs reduced to their origin.
 */
import { listAuditSinks } from "./sinks";
import { AUDIT_SINK_TYPE_LABELS, type AuditSinkView, type SplunkHecSinkConfig, type SyslogSinkConfig, type WebhookSinkConfig } from "./types";
import type { AuditSinkSummary } from "./ui/sink-view";

/** The origin of a URL (paths and queries can carry tokens), or the syslog address. */
function sinkTarget(sink: AuditSinkView): string {
  if (sink.type === "syslog") {
    const config = sink.config as SyslogSinkConfig;
    return `${config.protocol}://${config.host}:${config.port}`;
  }
  const url = (sink.config as WebhookSinkConfig | SplunkHecSinkConfig).url;
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

function sinkTypeLabel(sink: AuditSinkView): string {
  if (sink.type === "syslog") return `Syslog over ${(sink.config as SyslogSinkConfig).protocol.toUpperCase()}`;
  return AUDIT_SINK_TYPE_LABELS[sink.type];
}

export function toSinkSummary(sink: AuditSinkView): AuditSinkSummary {
  return {
    id: sink.id,
    name: sink.name,
    typeLabel: sinkTypeLabel(sink),
    target: sinkTarget(sink),
    enabled: sink.enabled,
    lastDeliveredId: sink.lastDeliveredId,
    pendingEvents: sink.pendingEvents,
    oldestPendingAt: sink.oldestPendingAt,
    lastDeliveryAt: sink.lastDeliveryAt,
    lastError: sink.lastError,
    consecutiveFailures: sink.consecutiveFailures,
    nextAttemptAt: sink.nextAttemptAt,
  };
}

/** Every audit sink as a summary. */
export async function listAuditSinkSummaries(): Promise<AuditSinkSummary[]> {
  return (await listAuditSinks()).map(toSinkSummary);
}
