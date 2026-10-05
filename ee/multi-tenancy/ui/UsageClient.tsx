// SPDX-License-Identifier: Elastic-2.0
"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Download } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { KpiTile } from "@/components/ui/KpiTile";
import { SectionCard } from "@/components/ui/SectionCard";
import { StatusDot } from "@/components/ui/StatusDot";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Pagination, useUrlPage } from "@/components/ui/Pagination";
import { SearchField } from "@/components/ui/SearchField";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatBytes, formatCount } from "@/components/ui/chart-format";
import { cn } from "@/lib/utils";
import { DEFAULT_PAGE_SIZE, paginate } from "@/src/lib/pagination";
import type { UsageReport } from "@/ee/multi-tenancy/usage";

type Props = {
  initialReport: UsageReport;
  /** Organisations a provider-level user can narrow the report to. */
  organizations: { id: number; name: string }[];
  providerLevel: boolean;
};

const ALL = "all";

function currentMonth(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

export default function UsageClient({ initialReport, organizations, providerLevel }: Props) {
  const router = useRouter();
  const { page, hrefFor } = useUrlPage();
  const [search, setSearch] = useState("");
  const [report, setReport] = useState(initialReport);
  const [month, setMonth] = useState(currentMonth());
  const [organization, setOrganization] = useState(ALL);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function query(format: "json" | "csv", monthValue = month, organizationValue = organization): string {
    const params = new URLSearchParams({ month: monthValue, format });
    if (organizationValue !== ALL) params.set("organizationId", organizationValue);
    return `/api/v1/usage-reports?${params.toString()}`;
  }

  /** A new month, organisation or search starts on the first page. */
  function firstPage() {
    if (page > 1) router.replace(hrefFor(1), { scroll: false });
  }

  function load(monthValue: string, organizationValue: string) {
    setError(null);
    firstPage();
    startTransition(async () => {
      try {
        const response = await fetch(query("json", monthValue, organizationValue));
        const data = await response.json();
        if (!response.ok) throw new Error(typeof data?.error === "string" ? data.error : `Request failed (HTTP ${response.status})`);
        setReport(data as UsageReport);
      } catch (failure) {
        setError((failure as Error).message);
      }
    });
  }

  const totals = report.rows.reduce(
    (sum, row) => ({
      proxyHosts: sum.proxyHosts + row.proxyHosts,
      enabledProxyHosts: sum.enabledProxyHosts + row.enabledProxyHosts,
      users: sum.users + row.users,
      requests: sum.requests + row.requests,
      bytes: sum.bytes + row.bytes,
      wafBlocks: sum.wafBlocks + row.wafBlocks,
    }),
    { proxyHosts: 0, enabledProxyHosts: 0, users: 0, requests: 0, bytes: 0, wafBlocks: 0 }
  );
  const scope = report.rows.length === 1 ? report.rows[0].organizationName : `All ${report.rows.length} rows`;
  const needle = search.trim().toLowerCase();
  const matching = needle
    ? report.rows.filter((row) => row.organizationName.toLowerCase().includes(needle) || (row.organizationSlug ?? "").includes(needle))
    : report.rows;
  const rowPage = paginate(matching, page);
  const head = "border-b border-line px-3 py-2.5 text-left text-xs font-medium text-soft";
  const cell = "px-3 py-3";

  return (
    <div className="flex w-full flex-col gap-5">
      <PageHeader
        className="mb-0"
        breadcrumb={["Platform", "Usage"]}
        title="Usage"
        actions={
          <Button variant="outline" asChild>
            <a href={query("csv")} download>
              <Download aria-hidden="true" />
              Download CSV
            </a>
          </Button>
        }
      />

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="usage-month">Month (UTC)</Label>
          <Input
            id="usage-month"
            type="month"
            className="num w-44"
            value={month}
            max={currentMonth()}
            onChange={(event) => {
              setMonth(event.target.value);
              if (event.target.value) load(event.target.value, organization);
            }}
          />
        </div>
        {providerLevel && organizations.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="usage-organization">Organisation</Label>
            <Select
              value={organization}
              onValueChange={(value) => {
                setOrganization(value);
                load(month, value);
              }}
            >
              <SelectTrigger id="usage-organization" className="w-60 max-w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All, and the provider level</SelectItem>
                <SelectItem value="provider">Provider level</SelectItem>
                {organizations.map((option) => (
                  <SelectItem key={option.id} value={String(option.id)}>
                    {option.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        <p className="num m-0 pb-2 text-xs text-soft">
          {report.period.from.slice(0, 10)} to {report.period.to.slice(0, 10)} UTC
        </p>
      </div>

      {!report.analyticsAvailable && (
        <Banner tone="info" title="Analytics are off.">
          Requests, bandwidth and WAF blocks show 0.
        </Banner>
      )}
      {error && (
        <Banner tone="bad" live onDismiss={() => setError(null)}>
          {error}
        </Banner>
      )}

      <div
        aria-busy={pending}
        className={cn("grid grid-cols-[repeat(auto-fit,minmax(min(180px,100%),1fr))] gap-3", pending && "opacity-60")}
      >
        <KpiTile label="Requests" value={formatCount(totals.requests)} color="var(--served)" note={scope} />
        <KpiTile label="Bandwidth" value={formatBytes(totals.bytes)} color="var(--served2)" note={scope} />
        <KpiTile label="WAF blocks" value={formatCount(totals.wafBlocks)} color="var(--waf)" note={scope} />
        <KpiTile
          label="Proxy hosts"
          value={formatCount(totals.proxyHosts)}
          note={totals.enabledProxyHosts === totals.proxyHosts ? "All enabled" : `${formatCount(totals.enabledProxyHosts)} enabled`}
        />
        <KpiTile label="Users" value={formatCount(totals.users)} note="Now" />
      </div>

      <SectionCard
        title={providerLevel ? "By organisation" : "Your organisation"}
        count={providerLevel ? report.rows.length : undefined}
        footer={<span className="text-xs text-soft">Hosts and users are counted now, not at the end of the period.</span>}
      >
        {report.rows.length > DEFAULT_PAGE_SIZE && (
          <div className="border-b border-line px-[18px] py-3">
            <SearchField
              aria-label="Filter organisations"
              type="search"
              placeholder="Name or slug"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                firstPage();
              }}
              className="w-full sm:max-w-xs"
            />
          </div>
        )}
        <div className="relative overflow-x-auto">
          <table className={cn("w-full min-w-[720px] border-collapse text-[13px]", pending && "opacity-60")}>
            <thead>
              <tr>
                <th scope="col" className={cn(head, "pl-[18px]")}>
                  Organisation
                </th>
                <th scope="col" className={cn(head, "text-right")}>
                  Proxy hosts
                </th>
                <th scope="col" className={cn(head, "text-right")}>
                  Users
                </th>
                <th scope="col" className={cn(head, "text-right")}>
                  Requests
                </th>
                <th scope="col" className={cn(head, "text-right")}>
                  Bandwidth
                </th>
                <th scope="col" className={cn(head, "pr-[18px] text-right")}>
                  WAF blocks
                </th>
              </tr>
            </thead>
            <tbody>
              {matching.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-[18px] py-6 text-center text-muted-foreground">
                    No organisations match.
                  </td>
                </tr>
              )}
              {rowPage.items.map((row) => (
                <tr key={row.organizationId ?? "provider"} className="border-b border-line transition-colors last:border-0 hover:bg-panel2">
                  <td className={cn(cell, "pl-[18px]")}>
                    <span className="flex flex-col gap-0.5">
                      <span className="font-semibold">{row.organizationName}</span>
                      {row.organizationSlug && <span className="num text-xs text-soft">{row.organizationSlug}</span>}
                      {!row.enabled && <StatusDot tone="off" label="Disabled" className="text-xs" />}
                    </span>
                  </td>
                  <td className={cn(cell, "num text-right")}>
                    {formatCount(row.proxyHosts)}
                    {row.enabledProxyHosts !== row.proxyHosts && (
                      <span className="block text-xs text-soft">{formatCount(row.enabledProxyHosts)} enabled</span>
                    )}
                  </td>
                  <td className={cn(cell, "num text-right")}>{formatCount(row.users)}</td>
                  <td className={cn(cell, "num text-right")}>{formatCount(row.requests)}</td>
                  <td className={cn(cell, "num text-right")}>{formatBytes(row.bytes)}</td>
                  <td className={cn(cell, "num pr-[18px] text-right")}>{formatCount(row.wafBlocks)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="border-t border-line px-[18px] py-3 empty:hidden">
          <Pagination
            page={rowPage.page}
            perPage={rowPage.perPage}
            total={rowPage.total}
            noun="rows"
            label="Pages of the usage report"
            hrefFor={hrefFor}
          />
        </div>
      </SectionCard>
    </div>
  );
}
