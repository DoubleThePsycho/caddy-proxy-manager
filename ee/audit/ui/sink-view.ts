// SPDX-License-Identifier: Elastic-2.0
/**
 * Audit streaming as the audit log pages show it (audit_streaming): the
 * sinks without secrets and the delivery lag. Safe to import from client
 * components.
 */

/** A streaming destination as the audit log page shows it: never a secret, URLs reduced to their origin. */
export type AuditSinkSummary = {
  id: number;
  name: string;
  typeLabel: string;
  target: string;
  enabled: boolean;
  lastDeliveredId: number;
  pendingEvents: number;
  oldestPendingAt: string | null;
  lastDeliveryAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  nextAttemptAt: string | null;
};

/** "45 s", "6 min", "3 h", "2 days" between two instants. */
export function formatLag(fromIso: string, nowIso: string): string {
  const seconds = Math.max(0, Math.round((Date.parse(nowIso) - Date.parse(fromIso)) / 1000));
  if (!Number.isFinite(seconds)) return "Unknown";
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.round(hours / 24)} days`;
}

/** Lag above this is shown as a problem. */
export const LAG_WARNING_MS = 5 * 60 * 1000;
