import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type StatusTone = "ok" | "warn" | "bad" | "off" | "info";

export type StatusDotProps = {
  tone: StatusTone;
  /** Text after the dot, e.g. "Healthy". Without it the dot stands alone. */
  label?: ReactNode;
  /** Read by screen readers when there is no visible label (e.g. "Healthy"); ignored with `label`. */
  srLabel?: string;
  /** A soft pulse on the dot, for something happening right now (a live feed). */
  pulse?: boolean;
  className?: string;
};

const DOT: Record<StatusTone, string> = {
  ok: "bg-ok",
  warn: "bg-warn",
  bad: "bg-bad",
  off: "bg-soft",
  info: "bg-served",
};

/** Healthy keeps the body colour; the other states tint their label like the dot. */
const LABEL: Record<StatusTone, string> = {
  ok: "text-foreground",
  warn: "text-warn",
  bad: "text-bad",
  off: "text-soft",
  info: "text-foreground",
};

/** An 8px status dot with an optional label: healthy, degraded, down, disabled or informational. */
export function StatusDot({ tone, label, srLabel, pulse = false, className }: StatusDotProps) {
  return (
    <span className={cn("inline-flex items-center gap-2 text-[13px] leading-5", LABEL[tone], className)}>
      <span aria-hidden="true" className="relative inline-flex h-2 w-2 shrink-0">
        {pulse && <span className={cn("absolute inset-0 animate-ping rounded-full opacity-60 motion-reduce:hidden", DOT[tone])} />}
        <span className={cn("relative inline-block h-2 w-2 rounded-full", DOT[tone])} />
      </span>
      {label ?? (srLabel ? <span className="sr-only">{srLabel}</span> : null)}
    </span>
  );
}
