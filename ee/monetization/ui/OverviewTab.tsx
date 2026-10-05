// SPDX-License-Identifier: Elastic-2.0
"use client";

import { useState } from "react";
import { KpiTile } from "@/components/ui/KpiTile";
import { SectionCard } from "@/components/ui/SectionCard";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { StackedBarChart } from "@/components/ui/StackedBarChart";
import { TopList } from "@/components/ui/TopList";
import { formatCount, formatDayUtc } from "@/components/ui/chart-format";
import type { ConsumerView, HostMonetizationView, MonetizationOverview, PlanView, StripeSettingsView } from "../types";
import ConsumersTab from "./ConsumersTab";
import HostsTab from "./HostsTab";
import PlansTab from "./PlansTab";
import { StripeSummary } from "./StripeTab";
import { money, monthName } from "./shared";
import { usdAmount } from "./X402Tab";

type Measure = "requests" | "amount";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function plural(count: number, word: string): string {
  return `${formatCount(count)} ${word}${count === 1 ? "" : "s"}`;
}

const pad = (value: number) => String(value).padStart(2, "0");

/** "11:36" (UTC) of an ISO timestamp. */
function clock(iso: string): string {
  const at = new Date(iso);
  return `${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}`;
}

export default function OverviewTab({
  overview,
  consumers,
  plans,
  hosts,
  stripe,
  canWrite,
  configurable,
  standalone,
  onAddConsumer,
  onOpenTab,
}: {
  overview: MonetizationOverview;
  consumers: ConsumerView[];
  plans: PlanView[];
  hosts: HostMonetizationView[];
  stripe: StripeSettingsView;
  canWrite: boolean;
  configurable: boolean;
  standalone: boolean;
  onAddConsumer: () => void;
  onOpenTab: (tab: "hosts" | "stripe" | "ledger") => void;
}) {
  const [measure, setMeasure] = useState<Measure>("requests");
  const currency = overview.currency;
  const month = monthName(overview.thisMonth.month);
  const previous = monthName(overview.previousMonth.month);
  const { thisMonth, previousMonth, balances } = overview;
  const now = overview.generatedAt;

  const buckets = overview.days.map((day) => Date.parse(`${day.day}T00:00:00.000Z`));
  const today = buckets[buckets.length - 1];
  const monthStartIndex = overview.days.findIndex((day) => day.day === thisMonth.month);
  const series =
    measure === "requests"
      ? [
          { key: "charged", label: "Charged requests", color: "var(--served)", values: overview.days.map((day) => day.chargedRequests) },
          { key: "free", label: "Free requests", color: "var(--served2)", values: overview.days.map((day) => day.freeRequests) },
        ]
      : [{ key: "amount", label: "Charged", color: "var(--served)", values: overview.days.map((day) => day.chargedMicros) }];

  const balanceNote = [
    `Held for ${plural(balances.heldFor, "consumer")}${balances.heldForDisabled > 0 ? `, ${formatCount(balances.heldForDisabled)} of them disabled` : ""}`,
    balances.overdrawn > 0 ? `${money(balances.overdrawnMicros, currency)} in overdraft` : null,
    balances.postpaidOpen > 0 ? `${money(balances.postpaidOpenMicros, currency)} owed by ${plural(balances.postpaidOpen, "postpaid consumer")}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const paidInNote = [
    plural(thisMonth.topUps, "top-up"),
    thisMonth.payments > 0 ? plural(thisMonth.payments, "postpaid payment") : null,
    thisMonth.refundedMicros > 0 ? `${money(thisMonth.refundedMicros, currency)} refunded or disputed` : null,
    `${previous} ${money(previousMonth.paidInMicros, currency)}`,
  ]
    .filter(Boolean)
    .join(" · ");
  const chargedNote = [
    `${formatCount(thisMonth.chargedRequests)} charged, ${formatCount(thisMonth.freeRequests)} free`,
    thisMonth.creditedRequests > 0
      ? `${money(thisMonth.creditedMicros, currency)} credited for ${plural(thisMonth.creditedRequests, "failed answer")}`
      : null,
    `${previous} ${money(previousMonth.chargedMicros, currency)}`,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <KpiTile
          label={`Paid in through Stripe, ${month}`}
          value={money(thisMonth.paidInMicros, currency)}
          note={paidInNote}
        />
        <KpiTile
          label={`Charged for requests, ${month}`}
          value={money(thisMonth.chargedMicros, currency)}
          note={chargedNote}
        />
        <KpiTile
          label={`Metered requests, ${month}`}
          value={formatCount(thisMonth.requests)}
          note={`To ${clock(now)} today · ${previous} ${formatCount(previousMonth.requests)}`}
        />
        <KpiTile label="Prepaid balances" value={money(balances.heldMicros, currency)} note={balanceNote} />
      </div>

      <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,360px)]">
        <SectionCard
          title={measure === "requests" ? "Metered requests per day, last 30 days" : "Amount charged per day, last 30 days"}
          divided={false}
          actions={
            <SegmentedControl<Measure>
              size="sm"
              label="Measure"
              value={measure}
              onChange={setMeasure}
              options={[
                { value: "requests", label: "Requests" },
                { value: "amount", label: "Amount charged" },
              ]}
            />
          }
          footer={
            <span className="text-soft">
              {formatDayUtc(buckets[0])} to {clock(now)} UTC today
            </span>
          }
        >
          <div className="px-[18px] pb-4">
            <StackedBarChart
              title={measure === "requests" ? "Metered requests per day" : "Amount charged per day"}
              buckets={buckets}
              stepSeconds={86_400}
              series={series}
              formatValue={measure === "requests" ? formatCount : (value) => money(value, currency)}
              formatBucket={(ms, long) => {
                if (ms === today) return long ? `Today, to ${clock(now)}` : "Today";
                return long ? `${WEEKDAYS[new Date(ms).getUTCDay()]} ${formatDayUtc(ms)}` : formatDayUtc(ms);
              }}
              bucketHeader="Day (UTC)"
              annotations={
                monthStartIndex > 0
                  ? [{ index: monthStartIndex, label: `1 ${formatDayUtc(buckets[monthStartIndex]).split(" ")[1]} · free requests reset`, color: "var(--soft)" }]
                  : []
              }
              height={240}
              xTicks={5}
              emptyText={measure === "requests" ? "No metered requests in the last 30 days." : "Nothing charged in the last 30 days."}
            />
          </div>
        </SectionCard>

        <SectionCard
          title={`Top consumers, ${month}`}
          actions={<span className="text-xs text-soft">Requests</span>}
        >
          <TopList
            framed={false}
            className="pt-1.5"
            rows={overview.topConsumers.map((top) => ({
              key: String(top.consumerId),
              label: top.name ?? `Deleted consumer #${top.consumerId}`,
              count: top.requests,
              sub: `${top.planName ?? "No plan"} · ${money(top.chargedMicros, currency)} charged`,
            }))}
            total={thisMonth.requests}
            formatCount={formatCount}
            emptyText={`No metered requests in ${month} yet.`}
          />
        </SectionCard>
      </div>

      {overview.x402.settled + overview.x402.failed + overview.x402.pending > 0 && (
        <SectionCard
          title={`x402 payments, ${month}`}
          actions={<span className="text-xs text-soft">{plural(overview.x402.settled, "settled payment")}</span>}
          footer={
            overview.x402.failed + overview.x402.pending > 0 ? (
              <span className="text-soft">
                {formatCount(overview.x402.failed)} failed · {formatCount(overview.x402.pending)} not recorded by Stripe
              </span>
            ) : undefined
          }
        >
          <div className="flex items-center justify-between gap-3 px-[18px] py-2.5 text-[13px]">
            <span>USDC on Base, recorded in your Stripe balance</span>
            <span className="num">{usdAmount(overview.x402.amountCents)}</span>
          </div>
        </SectionCard>
      )}

      <ConsumersTab
        consumers={consumers}
        plans={plans}
        currency={currency}
        usage={overview.consumers}
        monthLabel={month}
        now={now}
        canWrite={canWrite}
        configurable={configurable}
        onAdd={onAddConsumer}
        onShowLedger={() => onOpenTab("ledger")}
      />

      <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,400px)]">
        <div className="flex min-w-0 flex-col gap-4">
          <PlansTab plans={plans} currency={currency} canWrite={canWrite} configurable={configurable} />
          <HostsTab
            variant="overview"
            hosts={hosts}
            plans={plans}
            canWrite={canWrite}
            configurable={configurable}
            standalone={standalone}
            onShowAll={() => onOpenTab("hosts")}
          />
        </div>
        <StripeSummary settings={stripe} lastTopUp={overview.lastTopUp} now={now} onEdit={() => onOpenTab("stripe")} />
      </div>
    </div>
  );
}

