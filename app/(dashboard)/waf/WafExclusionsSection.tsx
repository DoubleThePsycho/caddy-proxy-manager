"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Pagination } from "@/components/ui/Pagination";
import { SearchField } from "@/components/ui/SearchField";
import { paginate } from "@/src/lib/pagination";
import { deleteWafExclusionAction } from "./actions";
import { WafExclusionDialog } from "./WafExclusionDialog";
import type { WafExclusionRow, WafHostRow } from "./waf-settings-shared";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2 Oct, 18:31 UTC" this year, "2 Oct 2025" before. */
function shortDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const day = `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
  if (date.getUTCFullYear() !== new Date().getUTCFullYear()) return `${day} ${date.getUTCFullYear()}`;
  return `${day}, ${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")} UTC`;
}

/** The host an exclusion is limited to, by its first domain; null for a global one. */
function scopeName(exclusion: WafExclusionRow): string | null {
  return exclusion.scope === "global" ? null : exclusion.host?.domains[0] ?? exclusion.host?.name ?? `host ${exclusion.proxyHostId}`;
}

/** Rule id, rule message, host, path, variable, reason or author containing the search. */
function matchesSearch(exclusion: WafExclusionRow, needle: string): boolean {
  if (!needle) return true;
  return [
    String(exclusion.ruleId),
    exclusion.ruleMessage,
    scopeName(exclusion) ?? "global",
    exclusion.host?.name,
    exclusion.path,
    exclusion.variable,
    exclusion.reason,
    exclusion.createdBy?.name,
  ].some((value) => typeof value === "string" && value.toLowerCase().includes(needle));
}

function ScopeChip({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <span className="inline-flex h-[22px] items-center gap-1.5 whitespace-nowrap rounded-full border px-2 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className={mono ? "font-mono" : undefined}>{value}</span>
    </span>
  );
}

/** The rule exclusions table, with adding and removing. */
export function WafExclusionsSection({
  exclusions,
  hosts,
  canWrite,
}: {
  exclusions: WafExclusionRow[];
  hosts: WafHostRow[];
  canWrite: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [pending, startTransition] = useTransition();
  const needle = search.trim().toLowerCase();
  // Newest first, so one just added is on the first page.
  const shown = paginate(
    exclusions.filter((exclusion) => matchesSearch(exclusion, needle)).sort((a, b) => b.id - a.id),
    page
  );

  function remove(exclusion: WafExclusionRow) {
    startTransition(async () => {
      const result = await deleteWafExclusionAction(exclusion.id);
      if (result.ok) {
        toast.success(result.message ?? "Exclusion removed");
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <section aria-labelledby="waf-exclusions-title" className="overflow-hidden rounded-xl border bg-card">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2.5 px-4 py-3.5">
        <h2 id="waf-exclusions-title" className="mr-auto text-base font-semibold">Rule exclusions</h2>
        {exclusions.length > 0 && (
          <SearchField
            type="search"
            aria-label="Search exclusions"
            placeholder="Search exclusions"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(1);
            }}
            className="w-full sm:w-56"
          />
        )}
        {canWrite && (
          <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
            <Plus aria-hidden="true" />
            Add exclusion
          </Button>
        )}
      </div>
      <div className="relative overflow-x-auto">
        <table className="w-full min-w-[880px] border-collapse text-sm">
          <thead>
            <tr className="border-y text-left text-xs text-muted-foreground">
              <th scope="col" className="w-[280px] px-4 py-2 font-medium">Rule</th>
              <th scope="col" className="px-2.5 py-2 font-medium">Scope</th>
              <th scope="col" className="px-2.5 py-2 font-medium">Reason</th>
              <th scope="col" className="px-2.5 py-2 font-medium">Added by</th>
              <th scope="col" className="py-2 pl-2.5 pr-4"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {shown.items.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-muted-foreground">
                  {exclusions.length === 0 ? "No rule exclusions." : "No exclusion matches."}
                </td>
              </tr>
            )}
            {shown.items.map((exclusion) => {
              const host = scopeName(exclusion);
              return (
                <tr key={exclusion.id} className="border-b last:border-b-0 hover:bg-muted/30">
                  <td className="px-4 py-2.5">
                    <span className="flex flex-col gap-0.5">
                      <span className="self-start rounded bg-muted px-1.5 font-mono text-xs leading-[18px] text-muted-foreground">{exclusion.ruleId}</span>
                      <span>{exclusion.ruleMessage ?? "Core Rule Set rule"}</span>
                    </span>
                  </td>
                  <td className="px-2.5 py-2.5">
                    <span className="flex flex-wrap gap-1">
                      {host ? <ScopeChip label="Host" value={host} /> : <ScopeChip label="Scope" value="Global" />}
                      {exclusion.path && (
                        <ScopeChip label={exclusion.pathMatch === "prefix" ? "Path under" : "Path"} value={exclusion.path} mono />
                      )}
                      {exclusion.variable && <ScopeChip label="Variable" value={exclusion.variable} mono />}
                    </span>
                  </td>
                  <td className="px-2.5 py-2.5 text-muted-foreground">{exclusion.reason || "No reason given"}</td>
                  <td className="whitespace-nowrap px-2.5 py-2.5">
                    <span className="flex flex-col">
                      <span>{exclusion.createdBy?.name ?? "Unknown"}</span>
                      <span className="font-mono text-xs text-muted-foreground">{shortDate(exclusion.createdAt)}</span>
                    </span>
                  </td>
                  <td className="py-2.5 pl-2.5 pr-4 text-right">
                    {canWrite && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-muted-foreground"
                        disabled={pending}
                        onClick={() => remove(exclusion)}
                        aria-label={`Remove exclusion of rule ${exclusion.ruleId}${host ? ` on ${host}` : ""}`}
                      >
                        <Trash2 aria-hidden="true" />
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {shown.pageCount > 1 && (
        <Pagination
          page={shown.page}
          perPage={shown.perPage}
          total={shown.total}
          noun="exclusions"
          label="Pages of exclusions"
          onPageChange={setPage}
          className="border-t px-4 py-3"
        />
      )}

      <WafExclusionDialog open={open} onOpenChange={setOpen} hosts={hosts} onCreated={() => router.refresh()} />
    </section>
  );
}
