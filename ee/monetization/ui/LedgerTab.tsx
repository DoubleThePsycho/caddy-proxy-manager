// SPDX-License-Identifier: Elastic-2.0
"use client";

import { useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Pagination, useUrlPage } from "@/components/ui/Pagination";
import { SectionCard } from "@/components/ui/SectionCard";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatCount } from "@/components/ui/chart-format";
import { formatDateTimeUtc } from "@/src/lib/date-format";
import { cn } from "@/lib/utils";
import type { ConsumerView, LedgerEntryView, LedgerPage } from "../types";
import type { X402PaymentPage } from "../x402/payments";
import { money } from "./shared";
import { X402PaymentsTable } from "./X402Tab";

const ALL = "all";
const TYPE_LABELS = {
  topup: "Top-up",
  usage: "Usage",
  adjustment: "Adjustment",
  credit: "Credit",
  payment: "Payment",
  refund: "Refund",
  dispute: "Dispute",
} as const;
const TYPE_VARIANT = {
  topup: "success",
  usage: "muted",
  adjustment: "warning",
  credit: "info",
  payment: "success",
  refund: "warning",
  dispute: "destructive",
} as const;

function plural(count: number, word: string): string {
  return `${formatCount(count)} ${word}${count === 1 ? "" : "s"}`;
}

function details(entry: LedgerEntryView): string {
  if (entry.type === "usage") {
    return `${plural(entry.requests, "request")}, ${formatCount(entry.freeRequests)} free`;
  }
  if (entry.type === "credit") {
    return `${plural(entry.requests, "failed answer")} credited back, ${formatCount(entry.freeRequests)} free`;
  }
  return entry.description ?? entry.reference ?? "";
}

/**
 * The ledger, a page at a time from the server: the page (?ledger=) and the
 * filters (?consumer=, ?type=) are in the address, so back and reload keep them.
 */
export default function LedgerTab({
  page,
  filter,
  consumers,
  currency,
  x402Payments,
}: {
  page: LedgerPage;
  /** "all" or a consumer id; "all" or an entry type. */
  filter: { consumer: string; type: string };
  consumers: ConsumerView[];
  currency: string;
  /** The latest x402 payments (no consumer account needed), shown under the ledger. */
  x402Payments?: X402PaymentPage;
}) {
  const router = useRouter();
  const pathname = usePathname() ?? "";
  const query = useSearchParams()?.toString() ?? "";
  const { hrefFor } = useUrlPage("ledger");
  const [pending, startTransition] = useTransition();

  /** A new filter starts on the first page. */
  function setFilter(key: "consumer" | "type", value: string) {
    const params = new URLSearchParams(query);
    if (value === ALL) params.delete(key);
    else params.set(key, value);
    params.delete("ledger");
    params.set("tab", "ledger");
    startTransition(() => router.replace(`${pathname}?${params.toString()}`, { scroll: false }));
  }

  return (
    <div className="flex flex-col gap-4">
    <SectionCard title="Ledger" count={page.total}>
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-[18px] py-3">
        <Select value={filter.consumer} onValueChange={(value) => setFilter("consumer", value)}>
          <SelectTrigger className="w-full sm:w-56" aria-label="Consumer">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Every consumer</SelectItem>
            {consumers.map((entry) => (
              <SelectItem key={entry.id} value={String(entry.id)}>
                {entry.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={filter.type} onValueChange={(value) => setFilter("type", value)}>
          <SelectTrigger className="w-full sm:w-44" aria-label="Entry type">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Every type</SelectItem>
            <SelectItem value="topup">Top-ups</SelectItem>
            <SelectItem value="usage">Usage</SelectItem>
            <SelectItem value="adjustment">Adjustments</SelectItem>
            <SelectItem value="credit">Failed-answer credits</SelectItem>
            <SelectItem value="payment">Postpaid payments</SelectItem>
            <SelectItem value="refund">Refunds</SelectItem>
            <SelectItem value="dispute">Disputes</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="overflow-x-auto">
        <Table aria-busy={pending}>
          <TableHeader>
            <TableRow>
              <TableHead>Time (UTC)</TableHead>
              <TableHead>Consumer</TableHead>
              <TableHead>Type</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead className="text-right">Balance after</TableHead>
              <TableHead>Details</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {page.entries.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="py-8 text-center text-[13px] text-soft">
                  No entries.
                </TableCell>
              </TableRow>
            )}
            {page.entries.map((entry) => (
              <TableRow key={entry.id}>
                <TableCell className="num whitespace-nowrap text-xs">{formatDateTimeUtc(entry.updatedAt)}</TableCell>
                <TableCell>{entry.consumerName ?? <span className="text-soft">Deleted consumer #{entry.consumerId}</span>}</TableCell>
                <TableCell>
                  <Badge variant={TYPE_VARIANT[entry.type]}>{TYPE_LABELS[entry.type]}</Badge>
                </TableCell>
                <TableCell className={cn("num whitespace-nowrap text-right", entry.amountMicros > 0 && "text-ok", entry.amountMicros === 0 && "text-soft")}>
                  {entry.amountMicros > 0 ? "+" : ""}
                  {money(entry.amountMicros, currency)}
                </TableCell>
                <TableCell className={cn("num whitespace-nowrap text-right", entry.balanceAfterMicros < 0 && "text-bad")}>
                  {money(entry.balanceAfterMicros, currency)}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">{details(entry)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <div className="border-t border-line px-[18px] py-3 empty:hidden">
        <Pagination page={page.page} perPage={page.perPage} total={page.total} noun="entries" label="Pages of the ledger" hrefFor={hrefFor} />
      </div>
    </SectionCard>
    {x402Payments && (x402Payments.total > 0) && (
      <SectionCard title="Latest x402 payments" count={x402Payments.total}>
        <X402PaymentsTable page={x402Payments} />
      </SectionCard>
    )}
    </div>
  );
}
