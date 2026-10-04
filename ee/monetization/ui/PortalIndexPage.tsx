// SPDX-License-Identifier: Elastic-2.0
import type { Metadata } from "next";
import { brandName } from "@/ee/white-label/store";
import PortalClient from "@/ee/monetization/ui/PortalClient";
import { portalResult, type PortalSearch } from "@/ee/monetization/ui/portal-result";

export const metadata: Metadata = { title: "API account", robots: { index: false, follow: false } };

/**
 * API monetization: where 402 answers send consumers by default. The consumer
 * pastes an API key to see their balance and pay (no account needed).
 */
export default async function ApiPortalLandingPage({ searchParams }: { searchParams: Promise<PortalSearch> }) {
  return <PortalClient brandName={brandName()} mode="key" result={portalResult(await searchParams)} />;
}
