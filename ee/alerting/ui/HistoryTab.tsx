// SPDX-License-Identifier: Elastic-2.0
"use client";

import Link from "next/link";
import { ArrowLeft, ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/EmptyState";
import { SectionCard } from "@/components/ui/SectionCard";
import { StatusDot } from "@/components/ui/StatusDot";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useFormat } from "@/components/preferences/PreferencesProvider";
import type { AlertEventView } from "@/ee/alerting/types";
import { DeliveryChip, SeverityPill } from "./parts";

type Props = { history: { events: AlertEventView[]; total: number; page: number; perPage: number } };

function Status({ event }: { event: AlertEventView }) {
  if (event.status === "resolved") return <StatusDot tone="ok" label="Resolved" />;
  return <StatusDot tone={event.severity === "critical" ? "bad" : "warn"} label="Firing" />;
}

function Delivery({ event }: { event: AlertEventView }) {
  if (!event.notified) return <span className="text-xs text-muted-foreground">Not sent (cooldown or no channel)</span>;
  if (event.deliveries.length === 0) return <span className="text-xs text-muted-foreground">Sending…</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {event.deliveries.map((delivery) => (
        <DeliveryChip key={delivery.channelId} delivery={delivery} />
      ))}
    </span>
  );
}

function pageHref(page: number): string {
  return page <= 1 ? "/alerts?tab=history" : `/alerts?tab=history&page=${page}`;
}

/** Every firing and resolved transition of the last 90 days, newest first. */
export default function HistoryTab({ history }: Props) {
  const format = useFormat();
  const pages = Math.max(1, Math.ceil(history.total / history.perPage));
  const first = history.total === 0 ? 0 : (history.page - 1) * history.perPage + 1;
  const last = Math.min(history.total, history.page * history.perPage);
  return (
    <div className="flex flex-col gap-3">
      <div>
        <Button asChild variant="ghost" size="sm">
          <Link href="/alerts">
            <ArrowLeft /> Firing alerts
          </Link>
        </Button>
      </div>
      <SectionCard
        title="Alert history"
        count={history.total}
        description="Every time a rule started or stopped firing."
        footer={
          <div className="flex flex-wrap items-center gap-3 text-xs text-soft">
            <span>History is kept for 90 days. Times in {format.timeZone}.</span>
            {pages > 1 && (
              <span className="ml-auto flex items-center gap-2 text-[13px] text-muted-foreground">
                <span>
                  <span className="num">{first}</span> to <span className="num">{last}</span> of <span className="num">{history.total}</span>
                </span>
                {history.page > 1 ? (
                  <Button asChild variant="outline" size="icon-sm" aria-label="Newer events">
                    <Link href={pageHref(history.page - 1)}>
                      <ChevronLeft />
                    </Link>
                  </Button>
                ) : (
                  <Button variant="outline" size="icon-sm" aria-label="Newer events" disabled>
                    <ChevronLeft />
                  </Button>
                )}
                {history.page < pages ? (
                  <Button asChild variant="outline" size="icon-sm" aria-label="Older events">
                    <Link href={pageHref(history.page + 1)}>
                      <ChevronRight />
                    </Link>
                  </Button>
                ) : (
                  <Button variant="outline" size="icon-sm" aria-label="Older events" disabled>
                    <ChevronRight />
                  </Button>
                )}
              </span>
            )}
          </div>
        }
      >
        {history.events.length === 0 ? (
          <EmptyState
            compact
            title="No alerts yet"
            description="Alerts appear here when a rule starts or stops firing; history is kept for 90 days."
          />
        ) : (
          <Table className="min-w-[960px]">
            <TableHeader>
              <TableRow>
                <TableHead scope="col" className="w-[190px]">Time</TableHead>
                <TableHead scope="col" className="w-[110px]">Status</TableHead>
                <TableHead scope="col">Alert</TableHead>
                <TableHead scope="col" className="w-[240px]">Delivery</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {history.events.map((event) => (
                <TableRow key={event.id} className="align-top">
                  <TableCell className="num whitespace-nowrap text-muted-foreground">{format.dateTime(event.createdAt)}</TableCell>
                  <TableCell>
                    <Status event={event} />
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col gap-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold [overflow-wrap:anywhere]">{event.title}</span>
                        {event.status === "firing" && <SeverityPill severity={event.severity} />}
                      </span>
                      <span className="text-xs text-soft">{event.ruleName}</span>
                      {event.message && <span className="whitespace-pre-line text-xs text-muted-foreground [overflow-wrap:anywhere]">{event.message}</span>}
                      {event.explanation && (
                        <div className="rounded-lg border border-line bg-panel2 p-2 text-xs">
                          <span className="font-semibold">AI-generated explanation: </span>
                          <span className="whitespace-pre-line">{event.explanation}</span>
                        </div>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Delivery event={event} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </SectionCard>
    </div>
  );
}
