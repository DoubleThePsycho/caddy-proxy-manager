// SPDX-License-Identifier: Elastic-2.0
/**
 * Attention provider: an online key the license server has not confirmed
 * (not yet after a day, failing for days, or no longer), or a license it
 * reports as revoked.
 */
import type { AttentionItem, AttentionProvider } from "@/src/lib/attention/types";
import { readLicenseCheck } from "./online-check-state";
import { getLicenseState } from "./store";

const DAY_MS = 24 * 60 * 60 * 1000;
const ACTIONS = [{ label: "License", route: "/license" }];

function day(iso: string): string {
  return iso.slice(0, 10);
}

export const licenseAttentionProvider: AttentionProvider = {
  id: "license",
  label: "License",
  permissions: ["license:read"],
  async collect({ now }) {
    const [state, check] = await Promise.all([getLicenseState(now), readLicenseCheck()]);
    const license = state.license;
    const online = state.onlineCheck;
    if (!license || !online || state.status === "expired") return [];
    const lastError = check.licenseId === license.id ? check.lastError : null;
    const at = check.licenseId === license.id ? check.lastAttemptAt : null;
    const item = (severity: AttentionItem["severity"], title: string, detail: string): Omit<AttentionItem, "source"> => ({
      id: license.id,
      severity,
      title,
      detail,
      actions: ACTIONS,
      at,
    });

    switch (online.state) {
      case "revoked":
        return [
          item(
            "critical",
            `License ${license.id} was revoked`,
            "The license server reports it as revoked, after a refund or a chargeback. Paid features already set up keep running; their settings are read-only."
          ),
        ];
      case "unconfirmed":
        return [
          item(
            "critical",
            `License ${license.id} could not be confirmed`,
            `${online.confirmedAt ? `No confirmation from the license server since ${day(online.confirmedAt)}` : "No confirmation from the license server"}` +
              `${lastError ? ` (${lastError})` : ""}. Paid settings are read-only until it confirms the license. ` +
              "Allow outbound HTTPS to license.ingres.si, or ask sales@ingres.si for an offline key."
          ),
        ];
      case "pending": {
        const seen = check.firstSeen[license.id];
        if (!seen || now.getTime() - Date.parse(seen) < DAY_MS) return [];
        return [
          item(
            "warning",
            `License ${license.id} is not confirmed yet`,
            `The license server has not confirmed it${lastError ? ` (${lastError})` : ""}. Paid settings become read-only on ` +
              `${online.validUntil ? day(online.validUntil) : "the seventh day"} unless it does. Allow outbound HTTPS to license.ingres.si.`
          ),
        ];
      }
      case "confirmed": {
        // Confirmations have failed for two days or more: say so before they run out.
        if (!lastError || !online.confirmedAt || now.getTime() - Date.parse(online.confirmedAt) < 2 * DAY_MS) return [];
        return [
          item(
            "warning",
            `License ${license.id} could not be confirmed lately`,
            `The last confirmation is from ${day(online.confirmedAt)} (${lastError}). Paid settings become read-only on ` +
              `${online.validUntil ? day(online.validUntil) : "expiry of the confirmation"} unless the license server confirms it again. ` +
              "Allow outbound HTTPS to license.ingres.si."
          ),
        ];
      }
    }
  },
};
