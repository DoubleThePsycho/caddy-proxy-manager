// SPDX-License-Identifier: Elastic-2.0
import { requirePermission } from "@/src/lib/auth";
import { can } from "@/src/lib/permissions";
import { getInstanceMode } from "@/src/lib/instance-sync";
import { EDITION_LABELS, FEATURE_INFO } from "@/ee/licensing/features";
import { isFeatureConfigurable } from "@/ee/licensing/store";
import { listConsumers } from "@/ee/monetization/consumers";
import { listHostMonetization } from "@/ee/monetization/hosts";
import { listLedger } from "@/ee/monetization/ledger";
import { getMonetizationOverview } from "@/ee/monetization/overview";
import { getStripeSettingsView } from "@/ee/monetization/payments";
import { listPlans } from "@/ee/monetization/plans";
import { getMonetizationOptionsView } from "@/ee/monetization/options";
import { getX402SettingsView } from "@/ee/monetization/x402/settings";
import { listX402Payments } from "@/ee/monetization/x402/payments";
import { FEATURE, MONETIZATION_TABS } from "@/ee/monetization/types";
import MonetizationClient from "@/ee/monetization/ui/MonetizationClient";

export const metadata = { title: "API monetization" };

export default async function ApiMonetizationPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const { access } = await requirePermission("monetization:read");
  const { tab: tabParam } = await searchParams;
  const initialTab = MONETIZATION_TABS.find((tab) => tab === tabParam) ?? "overview";
  // Every view below is free of secrets (the Stripe keys show as hasSecretKey / hasWebhookSecret).
  const [plans, consumers, hosts, ledger, configurable, mode, options, x402, x402Payments] = await Promise.all([
    listPlans(),
    listConsumers(),
    listHostMonetization(),
    listLedger({ page: 1, perPage: 50 }),
    isFeatureConfigurable(FEATURE),
    getInstanceMode(),
    getMonetizationOptionsView(),
    getX402SettingsView(),
    listX402Payments({ page: 1, perPage: 20 }),
  ]);
  // Month totals, the last 30 days and the top consumers, from the ledger; balances from the consumers above.
  const overview = await getMonetizationOverview({ consumers });
  return (
    <MonetizationClient
      initialTab={initialTab}
      overview={overview}
      plans={plans}
      consumers={consumers}
      hosts={hosts}
      stripe={await getStripeSettingsView()}
      ledger={ledger}
      configurable={configurable}
      canWrite={can(access, "monetization:write")}
      canManagePayments={can(access, "monetization:payments")}
      canManageReplicas={can(access, "instances:write")}
      standalone={mode !== "slave"}
      instanceMode={mode}
      options={options}
      x402={x402}
      x402Payments={x402Payments}
      editionLabel={EDITION_LABELS[FEATURE_INFO[FEATURE].edition]}
    />
  );
}
