// SPDX-License-Identifier: Elastic-2.0
import type { Metadata } from "next";
import { brandName } from "@/ee/white-label/store";
import { consumerForPortalToken, consumerSummary } from "@/ee/monetization/portal";
import PortalClient from "@/ee/monetization/ui/PortalClient";
import { portalResult, type PortalSearch } from "@/ee/monetization/ui/portal-result";

export const metadata: Metadata = {
  title: "API account",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

/**
 * API monetization: a consumer's self-service portal, reached through the
 * personal link an administrator issued (the token is stored hashed).
 */
export default async function ApiPortalPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<PortalSearch>;
}) {
  const [{ token }, search] = await Promise.all([params, searchParams]);
  const consumer = await consumerForPortalToken(token);
  return (
    <PortalClient
      brandName={brandName()}
      mode="token"
      token={consumer ? token : undefined}
      initial={consumer ? await consumerSummary(consumer) : null}
      result={portalResult(search)}
    />
  );
}
