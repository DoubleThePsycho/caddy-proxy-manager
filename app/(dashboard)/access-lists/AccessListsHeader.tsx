import Link from "next/link";
import type { ReactNode } from "react";
import { PageHeader } from "@/components/ui/PageHeader";
import { cn } from "@/lib/utils";

export const ACCESS_LISTS_HREF = "/access-lists";
export const BLOCKED_SOURCES_HREF = "/access-lists?tab=blocked-sources";

export function accessListHref(id: number): string {
  return `/access-lists/${id}`;
}

type Tab = "lists" | "blocked";

function TabLink({ href, current, label, count }: { href: string; current: boolean; label: string; count: number }) {
  return (
    <Link
      href={href}
      aria-current={current ? "page" : undefined}
      className={cn(
        "inline-flex h-10 shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 border-transparent px-3 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        current && "border-brand font-semibold text-foreground"
      )}
    >
      {label}
      <span className="num rounded-full bg-raise px-1.5 text-xs leading-[18px] text-muted-foreground">{count.toLocaleString("en-US")}</span>
    </Link>
  );
}

/**
 * The header of the Access lists pages: the hosts' own lists, and (for
 * provider-level users) the global Blocked sources list, as two tabs with
 * their own addresses.
 */
export function AccessListsHeader({
  tab,
  listCount,
  blockedCount,
  actions,
}: {
  tab: Tab;
  listCount: number;
  /** Null hides the Blocked sources tab (organisation users). */
  blockedCount: number | null;
  actions?: ReactNode;
}) {
  return (
    <PageHeader
      className="mb-0"
      breadcrumb={["Traffic", "Access lists"]}
      title="Access lists"
      count={blockedCount === null ? listCount : undefined}
      actions={actions}
    >
      {blockedCount !== null && (
        <nav aria-label="Access list sections" className="flex items-end gap-1 overflow-x-auto shadow-[inset_0_-1px_0_var(--line)] scrollbar-none">
          <TabLink href={ACCESS_LISTS_HREF} current={tab === "lists"} label="Lists" count={listCount} />
          <TabLink href={BLOCKED_SOURCES_HREF} current={tab === "blocked"} label="Blocked sources" count={blockedCount} />
        </nav>
      )}
    </PageHeader>
  );
}
