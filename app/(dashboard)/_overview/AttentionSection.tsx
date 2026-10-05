import Link from "next/link";
import { ChevronRight, CircleAlert, CircleCheck, Info, TriangleAlert, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/EmptyState";
import { SectionCard } from "@/components/ui/SectionCard";
import { cn } from "@/lib/utils";
import type { AttentionItem, AttentionSeverity, AttentionView } from "@/src/lib/attention/types";

const SEVERITY: Record<AttentionSeverity, { label: string; Icon: LucideIcon; box: string }> = {
  critical: { label: "Critical", Icon: CircleAlert, box: "bg-bad-tint text-bad" },
  warning: { label: "Warning", Icon: TriangleAlert, box: "bg-warn-tint text-warn" },
  info: { label: "Information", Icon: Info, box: "bg-brand-tint text-brand" },
};

function joinLabels(labels: readonly string[]): string {
  if (labels.length <= 1) return labels[0] ?? "";
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

function AttentionRow({ item }: { item: AttentionItem }) {
  const severity = SEVERITY[item.severity];
  const [first] = item.actions;
  return (
    <li
      className="relative flex items-start gap-3 border-b border-line py-2.5 pr-2.5 pl-3.5 last:border-b-0 md:flex-wrap md:items-center md:gap-x-4 md:gap-y-3 md:px-[18px] md:py-3.5 max-md:has-[a:active]:bg-panel2"
      data-severity={item.severity}
    >
      <span aria-hidden="true" className={cn("grid h-8 w-8 shrink-0 place-items-center rounded-[9px]", severity.box)}>
        <severity.Icon className="h-[18px] w-[18px]" strokeWidth={2} />
      </span>
      <span className="flex min-w-0 flex-1 basis-0 flex-col gap-0.5 md:basis-[360px]">
        <span className="font-semibold text-pretty">
          <span className="sr-only">{severity.label}: </span>
          {item.title}
        </span>
        <span className="text-[13px] leading-[18px] text-muted-foreground text-pretty md:leading-5">{item.detail}</span>
      </span>
      {item.actions.length > 0 && (
        <span className="flex flex-wrap gap-2 max-md:hidden">
          {item.actions.map((action) => (
            <Button key={`${action.route}-${action.label}`} asChild variant="secondary" size="sm">
              <Link href={action.route}>{action.label}</Link>
            </Button>
          ))}
        </span>
      )}
      {first && (
        <>
          {/* On a phone the whole row opens the first action, as Phone.dc.html shows. */}
          <Link href={first.route} aria-label={`${item.title}: ${first.label}`} className="absolute inset-0 md:hidden" />
          <ChevronRight aria-hidden="true" className="mt-2 h-4 w-4 shrink-0 text-soft md:hidden" />
        </>
      )}
    </li>
  );
}

/**
 * "Needs attention": the items of GET /api/v1/overview/attention for this
 * viewer, most severe first, each with the pages that deal with it.
 */
export function AttentionSection({
  attention,
  alertsHref,
  exclude = [],
  hideWhenEmpty = false,
}: {
  attention: AttentionView;
  /** "Alert rules" in the title row, for readers of the alerts. */
  alertsHref?: string | null;
  /** Sources left out (the first-run page shows the checklist itself). */
  exclude?: readonly string[];
  /** Leave the whole section out when nothing needs attention. */
  hideWhenEmpty?: boolean;
}) {
  const items = attention.items.filter((item) => !exclude.includes(item.source));
  if (hideWhenEmpty && items.length === 0) return null;
  const silent = attention.sources.filter((source) => source.status !== "ok" && !exclude.includes(source.id));
  const count = attention.truncated && items.length === attention.items.length ? `${items.length}+` : items.length;
  return (
    <SectionCard
      title="Needs attention"
      count={items.length > 0 ? count : null}
      link={alertsHref ? { label: "Alert rules", href: alertsHref } : undefined}
      className="max-md:[&>div:first-child]:px-3.5 max-md:[&>div:first-child]:py-2.5"
      footer={
        silent.length > 0 ? (
          <span className="text-soft">
            {joinLabels(silent.map((source) => source.label))} did not answer in time: {silent.length === 1 ? "its" : "their"} items may be missing.
          </span>
        ) : undefined
      }
    >
      {items.length === 0 ? (
        <EmptyState
          compact
          icon={CircleCheck}
          title="Nothing needs attention right now"
          className="px-[18px]"
        />
      ) : (
        <ul className="m-0 list-none p-0" data-testid="attention-list">
          {items.map((item) => (
            <AttentionRow key={`${item.source}:${item.id}`} item={item} />
          ))}
        </ul>
      )}
    </SectionCard>
  );
}
