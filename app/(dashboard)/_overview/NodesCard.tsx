import Link from "next/link";
import { SectionCard } from "@/components/ui/SectionCard";
import { StatusDot } from "@/components/ui/StatusDot";
import { cn } from "@/lib/utils";
import type { OverviewNodes } from "@/src/lib/overview-shared";
import { relativeLabel } from "./format";

const MODE_LABELS: Record<OverviewNodes["mode"], string> = {
  standalone: "Standalone",
  master: "Master",
  slave: "Replica",
};

const TONE_LABELS = { ok: "Healthy", warn: "Needs attention", bad: "Failing", off: "Not active", info: "Information" } as const;

/** This server and, on a master, its replicas: health, what they last did and the release they run. */
export function NodesCard({ nodes, now }: { nodes: OverviewNodes; now: number }) {
  return (
    <SectionCard
      title="Nodes"
      description={MODE_LABELS[nodes.mode]}
      link={nodes.link ?? undefined}
      footer={
        nodes.more > 0 && nodes.link ? (
          <Link href={nodes.link.href} className="text-brand underline-offset-4 hover:underline">
            {nodes.more} more {nodes.more === 1 ? "replica" : "replicas"}
          </Link>
        ) : nodes.more > 0 ? (
          <span className="text-soft">
            {nodes.more} more {nodes.more === 1 ? "replica" : "replicas"}
          </span>
        ) : undefined
      }
    >
      <ul className="m-0 list-none py-1.5 pl-0" data-testid="overview-nodes">
        {nodes.nodes.map((node) => (
          <li key={node.key} className="flex items-center gap-3 px-[18px] py-2.5">
            <StatusDot tone={node.tone} srLabel={TONE_LABELS[node.tone]} />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="num truncate font-medium">{node.name}</span>
              <span className="text-xs text-soft">
                {node.detail}
                {node.at ? ` · ${relativeLabel(node.at, now)}` : ""}
              </span>
            </span>
            {node.version && (
              <span
                className={cn("num shrink-0 text-xs", node.versionDiffers ? "text-warn" : "text-muted-foreground")}
                title={node.versionDiffers ? "Runs another release than this server" : undefined}
              >
                {node.version}
              </span>
            )}
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}
