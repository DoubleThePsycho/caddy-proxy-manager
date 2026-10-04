// SPDX-License-Identifier: Elastic-2.0
"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SectionCard } from "@/components/ui/SectionCard";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatCount } from "@/components/ui/chart-format";
import { formatDateTimeUtc } from "@/src/lib/date-format";
import { cn } from "@/lib/utils";
import type { ConsumerView, LedgerEntryView, LedgerPage } from "../types";
import type { X402PaymentPage } from "../x402/payments";
import { callApi, money } from "./shared";
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

export default function LedgerTab({
  initial,
  consumers,
  currency,
  x402Payments,
}: {
  initial: LedgerPage;
  consumers: ConsumerView[];
  currency: string;
  /** The latest x402 payments (no consumer account needed), shown under the ledger. */
  x402Payments?: X402PaymentPage;
}) {
  const [page, setPage] = useState<LedgerPage>(initial);
  const [consumer, setConsumer] = useState(ALL);
  const [type, setType] = useState(ALL);
  const [pending, startTransition] = useTransition();
  const pages = Math.max(1, Math.ceil(page.total / page.perPage));

  function load(next: { page?: number; consumer?: string; type?: string }) {
    const query = new URLSearchParams({ page: String(next.page ?? 1), perPage: String(page.perPage) });
    const consumerValue = next.consumer ?? consumer;
    const typeValue = next.type ?? type;
    if (consumerValue !== ALL) query.set("consumerId", consumerValue);
    if (typeValue !== ALL) query.set("type", typeValue);
    startTransition(async () => {
      try {
        setPage(await callApi<LedgerPage>(`/ledger?${query}`));
      } catch (error) {
        toast.error((error as Error).message);
      }
    });
  }

  return (
    <div className="flex flex-col gap-4">
    <SectionCard
      title="Ledger"
      count={page.total}
      description="Every change of a balance. Usage and failed-answer credits are one entry per consumer and hour, updated while requests come in."
      footer={
        <div className="flex flex-wrap items-center justify-end gap-2">
          <span className="text-muted-foreground">
            Page <span className="num">{page.page}</span> of <span className="num">{pages}</span>
          </span>
          <Button variant="outline" size="sm" disabled={pending || page.page <= 1} onClick={() => load({ page: page.page - 1 })}>
            Previous
          </Button>
          <Button variant="outline" size="sm" disabled={pending || page.page >= pages} onClick={() => load({ page: page.page + 1 })}>
            Next
          </Button>
        </div>
      }
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-[18px] py-3">
        <Select
          value={consumer}
          onValueChange={(value) => {
            setConsumer(value);
            load({ consumer: value });
          }}
        >
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
        <Select
          value={type}
          onValueChange={(value) => {
            setType(value);
            load({ type: value });
          }}
        >
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
    </SectionCard>
    {x402Payments && (x402Payments.total > 0) && (
      <SectionCard title="x402 payments" count={x402Payments.total} description="Paid per request with x402, by address: no consumer account. The latest 20; all of them on the x402 tab and in the API.">
        <X402PaymentsTable page={x402Payments} />
      </SectionCard>
    )}
    </div>
  );
}
