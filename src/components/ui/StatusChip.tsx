import { cn } from "@/lib/utils";

type StatusType = "active" | "inactive" | "error" | "warning";

type StatusChipProps = {
  status: StatusType;
  label?: string;
  className?: string;
};

const STATUS_CONFIG: Record<StatusType, { dot: string; text: string; label: string }> = {
  active:   { dot: "bg-ok",   text: "text-foreground", label: "Active"  },
  inactive: { dot: "bg-soft", text: "text-soft",       label: "Paused"  },
  error:    { dot: "bg-bad",  text: "text-bad",        label: "Error"   },
  warning:  { dot: "bg-warn", text: "text-warn",       label: "Warning" },
};

export function StatusChip({ status, label, className }: StatusChipProps) {
  const config = STATUS_CONFIG[status];
  const displayLabel = label ?? config.label;

  return (
    <span className={cn(
      "inline-flex h-[22px] items-center gap-1.5 rounded-full border border-line2 px-2",
      className
    )}>
      <span className={cn("w-2 h-2 rounded-full shrink-0", config.dot)} />
      <span className={cn("text-xs font-medium leading-none", config.text)}>
        {displayLabel}
      </span>
    </span>
  );
}
