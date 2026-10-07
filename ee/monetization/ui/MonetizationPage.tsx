// SPDX-License-Identifier: Elastic-2.0
import { requirePermission } from "@/src/lib/auth";
import { can } from "@/src/lib/permissions";
import { getInstanceMode } from "@/src/lib/instance-sync";
import { DEFAULT_PAGE_SIZE, parsePageParam } from "@/src/lib/pagination";
import { listConsumers } from "@/ee/monetization/consumers";
import { listHostMonetization } from "@/ee/monetization/hosts";
import { listLedger } from "@/ee/monetization/ledger";
import { getMonetizationOverview } from "@/ee/monetization/overview";
import { getStripeSettingsView } from "@/ee/monetization/payments";
import { listPlans } from "@/ee/monetization/plans";
import { getMonetizationOptionsView } from "@/ee/monetization/options";
import { getX402SettingsView } from "@/ee/monetization/x402/settings";
import { listX402Payments } from "@/ee/monetization/x402/payments";
import { LEDGER_TYPES, MONETIZATION_TABS, type LedgerType } from "@/ee/monetization/types";
import MonetizationClient from "@/ee/monetization/ui/MonetizationClient";

export const metadata = { title: "API monetization" };

type Search = { tab?: string; ledger?: string; consumer?: string; type?: string; payments?: string };

/** The ledger's filters from the address: a consumer id and an entry type, each "all" when absent or unknown. */
function ledgerFilter(search: Search): { consumerId: number | null; type: LedgerType | null } {
  const consumerId = /^\d{1,9}$/.test(search.consumer ?? "") ? Number(search.consumer) : null;
  const type = LEDGER_TYPES.find((value) => value === search.type) ?? null;
  return { consumerId: consumerId && consumerId > 0 ? consumerId : null, type };
}

export default async function ApiMonetizationPage({ searchParams }: { searchParams: Promise<Search> }) {
  const { access } = await requirePermission("monetization:read");
  const search = await searchParams;
  const initialTab = MONETIZATION_TABS.find((tab) => tab === search.tab) ?? "overview";
  const filter = ledgerFilter(search);
  const ledgerPage = parsePageParam(search.ledger);
  const paymentsPage = parsePageParam(search.payments);
  // Every view below is free of secrets (the Stripe keys show as hasSecretKey / hasWebhookSecret).
  const [plans, consumers, hosts, ledgerRead, mode, options, x402, x402Read, x402Latest] = await Promise.all([
    listPlans(),
    listConsumers(),
    listHostMonetization(),
    listLedger({ ...filter, page: ledgerPage, perPage: DEFAULT_PAGE_SIZE }),
    getInstanceMode(),
    getMonetizationOptionsView(),
    getX402SettingsView(),
    listX402Payments({ page: paymentsPage, perPage: DEFAULT_PAGE_SIZE }),
    listX402Payments({ page: 1, perPage: 20 }),
  ]);
  // A page past the last one shows the last one.
  const lastLedgerPage = Math.max(1, Math.ceil(ledgerRead.total / DEFAULT_PAGE_SIZE));
  const ledger = ledgerPage > lastLedgerPage ? await listLedger({ ...filter, page: lastLedgerPage, perPage: DEFAULT_PAGE_SIZE }) : ledgerRead;
  const lastPaymentsPage = Math.max(1, Math.ceil(x402Read.total / DEFAULT_PAGE_SIZE));
  const x402Payments = paymentsPage > lastPaymentsPage ? await listX402Payments({ page: lastPaymentsPage, perPage: DEFAULT_PAGE_SIZE }) : x402Read;
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
      ledgerFilter={{ consumer: filter.consumerId === null ? "all" : String(filter.consumerId), type: filter.type ?? "all" }}
      canWrite={can(access, "monetization:write")}
      canManagePayments={can(access, "monetization:payments")}
      canManageReplicas={can(access, "instances:write")}
      standalone={mode !== "slave"}
      instanceMode={mode}
      options={options}
      x402={x402}
      x402Payments={x402Payments}
      x402Latest={x402Latest}
    />
  );
}
