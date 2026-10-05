"use client";

import Link from "next/link";
import { ArrowLeftRight, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/EmptyState";
import { SectionCard } from "@/components/ui/SectionCard";
import { StatusDot } from "@/components/ui/StatusDot";
import { cn } from "@/lib/utils";
import { useFormat } from "@/src/components/preferences/PreferencesProvider";
import { HOST_WARN_ERROR_RATE, type OverviewHostRow, type OverviewHosts } from "@/src/lib/overview-shared";
import { clockLabel } from "./format";

function certificateText(days: number | null): { text: string; tone: string } {
  if (days === null) return { text: "–", tone: "text-soft" };
  if (days < 0) return { text: "Expired", tone: "text-bad font-semibold" };
  if (days < 7) return { text: `${days} ${days === 1 ? "day" : "days"}`, tone: "text-bad font-semibold" };
  if (days < 14) return { text: `${days} days`, tone: "text-warn" };
  return { text: `${days} days`, tone: "text-muted-foreground" };
}

function BurstPill({ burst, timeZone }: { burst: NonNullable<OverviewHostRow["burst"]>; timeZone: string }) {
  const status = burst.status >= 500 ? String(burst.status) : "5xx";
  return (
    <span
      className={cn(
        "rounded-full px-1.5 text-xs leading-[18px] whitespace-nowrap",
        burst.ongoing ? "bg-bad-tint text-bad" : "bg-warn-tint text-warn"
      )}
    >
      {burst.ongoing ? `${status} errors now` : `${status} burst at ${clockLabel(burst.start * 1000, timeZone)}`}
    </span>
  );
}

function NewHostButton() {
  return (
    <Button asChild variant="secondary" size="sm">
      <Link href="/proxy-hosts?create=1">
        <Plus aria-hidden="true" />
        New proxy host
      </Link>
    </Button>
  );
}

/**
 * The busiest proxy hosts of the range: status, a bar relative to the
 * busiest, requests, 5xx rate, mitigated requests and the certificate's
 * days left. On a phone the mitigated and certificate columns are left out.
 */
export function BusiestHosts({
  hosts,
  canCreate,
  canList,
  compact = false,
}: {
  hosts: OverviewHosts;
  canCreate: boolean;
  /** proxy_hosts:read: "All N hosts". */
  canList: boolean;
  /** The first-run page's short list. */
  compact?: boolean;
}) {
  const fmt = useFormat();
  const traffic = hosts.status === "ok";
  const link = canList && hosts.total > 0 && !compact ? { label: `All ${fmt.number(hosts.total)} ${hosts.total === 1 ? "host" : "hosts"}`, href: "/proxy-hosts" } : undefined;
  const description = hosts.status === "disabled" ? "Analytics are off" : hosts.status === "unavailable" ? "No traffic figures right now" : undefined;

  if (hosts.total === 0) {
    return (
      <SectionCard title="Busiest hosts" count={compact ? 0 : null}>
        <EmptyState
          compact
          icon={ArrowLeftRight}
          title="No proxy hosts yet"
          action={canCreate ? <NewHostButton /> : undefined}
          className="px-5"
        />
      </SectionCard>
    );
  }

  if (compact) {
    return (
      <SectionCard title="Busiest hosts" count={hosts.total}>
        <ul className="m-0 list-none py-1.5 pl-0">
          {hosts.rows.slice(0, 5).map((row) => (
            <li key={row.id} className="flex items-center gap-3 px-5 py-2">
              <StatusDot tone={row.tone} srLabel={row.toneLabel} />
              <span className="min-w-0 flex-1 truncate font-medium" title={row.name}>
                {row.href ? (
                  <Link href={row.href} className="text-foreground hover:underline underline-offset-4">
                    {row.label}
                  </Link>
                ) : (
                  row.label
                )}
              </span>
              <span className="num text-[13px] text-muted-foreground">{traffic ? fmt.number(row.requests) : "–"}</span>
            </li>
          ))}
        </ul>
      </SectionCard>
    );
  }

  const head = "border-y border-line py-2 font-medium";
  return (
    <SectionCard title="Busiest hosts" description={description} link={link} divided={false}>
      <div className="relative overflow-x-auto">
        <table className="w-full border-collapse text-[13px] md:min-w-[640px]" data-testid="busiest-hosts">
          <thead>
            <tr className="text-left text-xs text-soft">
              <th scope="col" className={cn(head, "pr-2.5 pl-[18px]")}>Host</th>
              <th scope="col" className={cn(head, "px-2.5")}>Requests</th>
              <th scope="col" className={cn(head, "px-2.5 text-right")}>5xx</th>
              <th scope="col" className={cn(head, "px-2.5 text-right max-md:hidden")}>Mitigated</th>
              {hosts.certificates && <th scope="col" className={cn(head, "pr-[18px] pl-2.5 text-right max-md:hidden")}>Certificate</th>}
            </tr>
          </thead>
          <tbody>
            {hosts.rows.map((row) => {
              const certificate = certificateText(row.certificateDaysLeft);
              const highErrors = row.errors5xx > 0 && row.errorRate5xx >= HOST_WARN_ERROR_RATE;
              return (
                <tr key={row.id} className="border-b border-line last:border-b-0 hover:bg-panel2">
                  <td className="py-2.5 pr-2.5 pl-[18px]">
                    <span className="flex min-w-0 items-center gap-2.5">
                      <StatusDot tone={row.tone} srLabel={row.toneLabel} />
                      <span className="min-w-0 truncate font-medium max-md:max-w-[150px]" title={row.name === row.label ? undefined : row.name}>
                        {row.href ? (
                          <Link href={row.href} className="text-foreground underline-offset-4 hover:underline">
                            {row.label}
                          </Link>
                        ) : (
                          row.label
                        )}
                      </span>
                      {row.burst && <span className="max-md:hidden"><BurstPill burst={row.burst} timeZone={fmt.timeZone} /></span>}
                      {!row.enabled && <span className="text-xs text-soft">disabled</span>}
                    </span>
                  </td>
                  <td className="px-2.5 py-2.5">
                    <span className="flex items-center gap-2.5">
                      <span aria-hidden="true" className="h-1.5 w-24 shrink-0 overflow-hidden rounded-[3px] bg-raise max-md:hidden">
                        <span className="block h-full bg-served" style={{ width: `${(row.share * 100).toFixed(1)}%` }} />
                      </span>
                      <span className="num">{traffic ? fmt.number(row.requests) : "–"}</span>
                    </span>
                  </td>
                  <td className={cn("num px-2.5 py-2.5 text-right", highErrors && "font-semibold text-bad")}>
                    {traffic ? fmt.percent(row.errorRate5xx, 2) : "–"}
                  </td>
                  <td className="num px-2.5 py-2.5 text-right max-md:hidden">{traffic ? fmt.number(row.mitigated) : "–"}</td>
                  {hosts.certificates && (
                    <td className={cn("py-2.5 pr-[18px] pl-2.5 text-right max-md:hidden", certificate.tone)}>{certificate.text}</td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </SectionCard>
  );
}
