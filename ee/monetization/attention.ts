// SPDX-License-Identifier: Elastic-2.0
/**
 * Attention provider of API monetization: Stripe refusing the secret key
 * (postpaid charges wait, stripe-status.ts) and x402 payments settled on
 * chain that Stripe has not recorded (their requests are not served until it
 * does).
 */
import type { AttentionProvider } from "@/src/lib/attention/types";
import { readStripeKeyRejection } from "./stripe-status";
import { x402PaymentsNeedingAttention } from "./x402/payments";

export const monetizationAttentionProvider: AttentionProvider = {
  id: "monetization",
  label: "API monetization",
  permissions: ["monetization:read"],
  async collect() {
    const items: Awaited<ReturnType<AttentionProvider["collect"]>> = [];
    const rejection = await readStripeKeyRejection();
    if (rejection) {
      items.push({
        id: "stripe-key",
        severity: "critical",
        title: "Stripe refuses the secret key",
        detail: `Stripe answered HTTP ${rejection.httpStatus} to a postpaid charge: the key was revoked or expired, or lacks a permission. Charges wait and no consumer is suspended; replace the key on the Stripe tab.`,
        actions: [{ label: "Stripe settings", route: "/api-monetization?tab=stripe" }],
        at: rejection.rejectedAt,
      });
    }
    // Paid (or maybe paid) on chain, not recorded in the Stripe balance: never served until Stripe confirms.
    const unrecorded = await x402PaymentsNeedingAttention();
    if (unrecorded.length > 0) {
      const notEnabled = unrecorded.some((payment) => payment.errorReason === "stripe_not_enabled");
      items.push({
        id: "x402-unrecorded",
        severity: "warning",
        title: `${unrecorded.length === 20 ? "20 or more" : unrecorded.length} x402 payment${unrecorded.length === 1 ? "" : "s"} not recorded by Stripe`,
        detail: notEnabled
          ? "Stripe has not enabled Stablecoins and Crypto on the account, so settled payments cannot be recorded; they are recorded once it does. The requests were not served."
          : "Payments settled on chain (or of unknown outcome) that Stripe has not confirmed: the requests were not served. Check them on the x402 tab.",
        actions: [{ label: "x402 payments", route: "/api-monetization?tab=x402" }],
        at: unrecorded[0].createdAt,
      });
    }
    return items;
  },
};
