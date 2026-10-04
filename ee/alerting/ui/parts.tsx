// SPDX-License-Identifier: Elastic-2.0
import type { ReactNode } from "react";
import { Check, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { AlertEventView, Severity } from "@/ee/alerting/types";
import { SEVERITY_LABELS } from "./format";

const SEVERITY_VARIANT: Record<Severity, "destructive" | "warning" | "muted"> = { critical: "destructive", warning: "warning", info: "muted" };
const SEVERITY_DOT: Record<Severity, string> = { critical: "bg-bad", warning: "bg-warn", info: "bg-soft" };

/** Critical, Warning or Info, tinted; with a dot where the design shows one. */
export function SeverityPill({ severity, dot = false, className }: { severity: Severity; dot?: boolean; className?: string }) {
  return (
    <Badge variant={SEVERITY_VARIANT[severity]} className={cn("font-semibold", className)}>
      {dot && <span aria-hidden="true" className={cn("h-1.5 w-1.5 rounded-full", SEVERITY_DOT[severity])} />}
      {SEVERITY_LABELS[severity]}
    </Badge>
  );
}

/** A channel told about an alert: a check when it was delivered, a cross and the error when not. */
export function DeliveryChip({ delivery }: { delivery: AlertEventView["deliveries"][number] }) {
  return (
    <span
      className={cn(
        "inline-flex h-[22px] items-center gap-1.5 whitespace-nowrap rounded-full border border-line2 px-2 text-xs",
        !delivery.ok && "text-bad"
      )}
      title={delivery.error ?? undefined}
    >
      {delivery.ok ? (
        <Check aria-hidden="true" className="h-3 w-3 text-ok" strokeWidth={3} />
      ) : (
        <X aria-hidden="true" className="h-3 w-3 text-bad" strokeWidth={3} />
      )}
      {delivery.channelName}
      {delivery.ok ? <span className="sr-only">: delivered</span> : ": failed"}
    </span>
  );
}

/** A plain chip, e.g. a channel name in the rules table. */
export function Chip({ children, tone, title }: { children: ReactNode; tone?: "bad"; title?: string }) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex h-[22px] items-center gap-1.5 whitespace-nowrap rounded-full border border-line2 px-2 text-xs",
        tone === "bad" && "text-bad"
      )}
    >
      {tone === "bad" && <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-bad" />}
      {children}
    </span>
  );
}

/** A count in a tab: warn-tinted when it needs attention. */
export function TabCount({ value, warn = false }: { value: number; warn?: boolean }) {
  return (
    <span
      className={cn(
        "num rounded-full px-1.5 text-[11px] leading-[18px] font-semibold",
        warn ? "bg-warn-tint text-warn" : "bg-raise text-muted-foreground"
      )}
    >
      {value}
    </span>
  );
}
