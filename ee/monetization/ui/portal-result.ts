// SPDX-License-Identifier: Elastic-2.0
import type { PortalResult } from "./PortalClient";

/** The query Stripe Checkout returns to the portal with. */
export type PortalSearch = { topup?: string; card?: string; payment?: string };

/** What came back from Stripe Checkout, from the portal page's query; null for anything else. */
export function portalResult(search: PortalSearch): PortalResult {
  if (search.topup === "success" || search.topup === "cancelled") return `topup-${search.topup}`;
  if (search.card === "saved" || search.card === "cancelled") return `card-${search.card}`;
  if (search.payment === "success" || search.payment === "cancelled") return `payment-${search.payment}`;
  return null;
}
