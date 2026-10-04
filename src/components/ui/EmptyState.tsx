import type { ReactNode } from "react";
import { Inbox, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export type EmptyStateProps = {
  /** What there is nothing of yet, as a short sentence: "No proxy hosts yet". */
  title: ReactNode;
  /** What it is for, or how to start. */
  description?: ReactNode;
  /** The icon in the rounded square. Default an inbox; null for none. */
  icon?: LucideIcon | null;
  /** A button or link to the first step. */
  action?: ReactNode;
  /** Smaller, left-aligned, for use inside a card or list. */
  compact?: boolean;
  /** Heading level of the title. Default 2 (3 when compact); 1 when the empty state is the whole page. */
  headingLevel?: 1 | 2 | 3 | 4;
  className?: string;
};

/** What a page or a card shows when it has nothing to list yet. */
export function EmptyState({ title, description, icon, action, compact = false, headingLevel, className }: EmptyStateProps) {
  const Icon = icon === undefined ? Inbox : icon;
  const Heading = `h${headingLevel ?? (compact ? 3 : 2)}` as "h1" | "h2" | "h3" | "h4";
  return (
    <div
      className={cn(
        "flex flex-col gap-3",
        compact ? "items-start px-4 py-5" : "items-center px-6 py-12 text-center",
        className
      )}
    >
      {Icon && (
        <span
          aria-hidden="true"
          className={cn(
            "grid shrink-0 place-items-center rounded-[10px] bg-raise text-muted-foreground",
            compact ? "h-8 w-8" : "h-11 w-11"
          )}
        >
          <Icon className={compact ? "h-4 w-4" : "h-5 w-5"} strokeWidth={1.8} />
        </span>
      )}
      <div className={cn("flex flex-col gap-1", !compact && "max-w-md items-center")}>
        <Heading className={cn("m-0 font-semibold text-foreground", compact ? "text-sm" : "text-base leading-6")}>{title}</Heading>
        {description && <p className="m-0 text-[13px] leading-[19px] text-muted-foreground">{description}</p>}
      </div>
      {action && <div className="flex flex-wrap items-center gap-2 pt-1">{action}</div>}
    </div>
  );
}
