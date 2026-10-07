// SPDX-License-Identifier: Elastic-2.0
/**
 * Attention provider: alerts firing now, except dismissed ones and those of
 * muted rules.
 */
import type { AttentionProvider } from "@/src/lib/attention/types";
import { listFiringAlerts } from "./events";

export const alertsAttentionProvider: AttentionProvider = {
  id: "alerts",
  label: "Alerts",
  permissions: ["alerts:read"],
  async collect() {
    const alerts = (await listFiringAlerts()).filter((alert) => !alert.dismissal && !alert.mute);
    return alerts.map((alert) => ({
      id: `${alert.ruleId}:${alert.subjectKey}`,
      severity: alert.severity,
      title: alert.title,
      detail: `${alert.message.slice(0, 300)}${alert.message.length > 300 ? "…" : ""} Rule "${alert.ruleName}".`,
      actions: [{ label: "Open alerts", route: "/alerts" }],
      at: alert.firedAt,
    }));
  },
};
