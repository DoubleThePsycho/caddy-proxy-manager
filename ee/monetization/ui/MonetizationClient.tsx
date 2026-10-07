// SPDX-License-Identifier: Elastic-2.0
"use client";

import { usePathname, useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { ExternalLink, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/PageHeader";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  PORTAL_PATH,
  type ConsumerView,
  type HostMonetizationView,
  type LedgerPage,
  type MonetizationOptionsView,
  type MonetizationOverview,
  type MonetizationTab,
  type PlanView,
  type StripeSettingsView,
} from "../types";
import ConsumerFormDialog from "./ConsumerFormDialog";
import ConsumersTab from "./ConsumersTab";
import HostsTab from "./HostsTab";
import LedgerTab from "./LedgerTab";
import OverviewTab from "./OverviewTab";
import PlansTab from "./PlansTab";
import SettingsTab from "./SettingsTab";
import StripeTab from "./StripeTab";
import X402Tab from "./X402Tab";
import type { X402SettingsView } from "../x402/settings";
import type { X402PaymentPage } from "../x402/payments";
import { monthName } from "./shared";

type Props = {
  initialTab: MonetizationTab;
  overview: MonetizationOverview;
  plans: PlanView[];
  consumers: ConsumerView[];
  hosts: HostMonetizationView[];
  stripe: StripeSettingsView;
  ledger: LedgerPage;
  /** The ledger's filters from the address ("all" or a consumer id; "all" or an entry type). */
  ledgerFilter?: { consumer: string; type: string };
  canWrite: boolean;
  /** May replace or remove the Stripe account (administrator-level). */
  canManagePayments: boolean;
  /** instances:write: replica serving decides what replicas receive. */
  canManageReplicas?: boolean;
  /** Monetization can be turned on here (not on a sync replica). */
  standalone: boolean;
  instanceMode: "standalone" | "master" | "slave";
  options: MonetizationOptionsView;
  x402: X402SettingsView;
  /** The page of x402 payments the x402 tab shows (?payments=). */
  x402Payments: X402PaymentPage;
  /** The latest x402 payments, under the ledger; the x402 tab's page when omitted. */
  x402Latest?: X402PaymentPage;
};

function TabLabel({ children, count }: { children: ReactNode; count?: number }) {
  return (
    <>
      {children}
      {count !== undefined && count > 0 && (
        <span className="num rounded-full bg-raise px-1.5 text-xs leading-[18px] font-semibold text-muted-foreground">{count}</span>
      )}
    </>
  );
}

export default function MonetizationClient(props: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const [tab, setTab] = useState<MonetizationTab>(props.initialTab);
  const [adding, setAdding] = useState(false);
  const currency = props.stripe.currency;
  const now = props.overview.generatedAt;
  const month = monthName(props.overview.thisMonth.month);

  function changeTab(value: string) {
    const next = value as MonetizationTab;
    setTab(next);
    router.replace(next === "overview" ? pathname : `${pathname}?tab=${next}`, { scroll: false });
  }

  const addConsumer = () => setAdding(true);

  return (
    <Tabs value={tab} onValueChange={changeTab} className="flex w-full flex-col gap-5">
      <PageHeader
        className="mb-0"
        breadcrumb={["Platform", "API monetization"]}
        title="API monetization"
        actions={
          <>
            <Button asChild variant="outline">
              <a href={PORTAL_PATH} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="h-4 w-4" /> Consumer portal
              </a>
            </Button>
            {props.canWrite && (
              <Button onClick={addConsumer}>
                <Plus className="h-4 w-4" /> Add consumer
              </Button>
            )}
          </>
        }
      >
        <TabsList aria-label="API monetization sections">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="plans">
            <TabLabel count={props.plans.length}>Plans</TabLabel>
          </TabsTrigger>
          <TabsTrigger value="consumers">
            <TabLabel count={props.consumers.length}>Consumers</TabLabel>
          </TabsTrigger>
          <TabsTrigger value="hosts">
            <TabLabel count={props.hosts.filter((host) => host.monetization?.enabled).length}>Hosts</TabLabel>
          </TabsTrigger>
          <TabsTrigger value="stripe">Stripe</TabsTrigger>
          <TabsTrigger value="x402">x402</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
          <TabsTrigger value="ledger">Ledger</TabsTrigger>
        </TabsList>
      </PageHeader>

      <TabsContent value="overview" className="mt-0">
        <OverviewTab
          overview={props.overview}
          consumers={props.consumers}
          plans={props.plans}
          hosts={props.hosts}
          stripe={props.stripe}
          canWrite={props.canWrite}
          standalone={props.standalone}
          onAddConsumer={addConsumer}
          onOpenTab={changeTab}
        />
      </TabsContent>
      <TabsContent value="plans" className="mt-0">
        <PlansTab
          plans={props.plans}
          currency={currency}
          canWrite={props.canWrite}
          analyticsAvailable={props.options.analyticsAvailable}
        />
      </TabsContent>
      <TabsContent value="consumers" className="mt-0 flex flex-col gap-4">
        <ConsumersTab
          consumers={props.consumers}
          plans={props.plans}
          currency={currency}
          usage={props.overview.consumers}
          monthLabel={month}
          now={now}
          canWrite={props.canWrite}
          onAdd={addConsumer}
          onShowLedger={() => changeTab("ledger")}
        />
      </TabsContent>
      <TabsContent value="hosts" className="mt-0">
        <HostsTab
          hosts={props.hosts}
          plans={props.plans}
          canWrite={props.canWrite}
          standalone={props.standalone}
          x402Configured={props.x402.configured}
        />
      </TabsContent>
      <TabsContent value="stripe" className="mt-0">
        <StripeTab settings={props.stripe} canWrite={props.canManagePayments} />
      </TabsContent>
      <TabsContent value="x402" className="mt-0">
        <X402Tab
          settings={props.x402}
          payments={props.x402Payments}
          canWrite={props.canManagePayments}
        />
      </TabsContent>
      <TabsContent value="settings" className="mt-0">
        <SettingsTab
          options={props.options}
          canWrite={props.canWrite}
          canManageReplicas={props.canWrite && props.canManageReplicas === true}
          instanceMode={props.instanceMode}
        />
      </TabsContent>
      <TabsContent value="ledger" className="mt-0">
        <LedgerTab
          page={props.ledger}
          filter={props.ledgerFilter ?? { consumer: "all", type: "all" }}
          consumers={props.consumers}
          currency={currency}
          x402Payments={props.x402Latest ?? props.x402Payments}
        />
      </TabsContent>

      {adding && <ConsumerFormDialog consumer={null} plans={props.plans} currency={currency} onClose={() => setAdding(false)} />}
    </Tabs>
  );
}
