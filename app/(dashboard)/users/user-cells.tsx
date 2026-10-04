"use client";

import type { ReactNode } from "react";
import { TriangleAlert } from "lucide-react";
import { StatusDot } from "@/components/ui/StatusDot";
import type { UserOverviewEntry } from "@/src/lib/users-overview";
import { cn } from "@/lib/utils";
import { useFormat } from "@/src/components/preferences/PreferencesProvider";
import { initials, statusOf, type FactorSummary } from "./user-format";

export function Tag({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn("rounded px-1.5 text-[11px] leading-[18px] text-muted-foreground", className ?? "bg-raise")}>{children}</span>
  );
}

export function Avatar({ name, className }: { name: string; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn("grid h-8 w-8 shrink-0 place-items-center rounded-full bg-raise text-xs font-semibold text-muted-foreground", className)}
    >
      {initials(name)}
    </span>
  );
}

export function FactorCell({ summary }: { summary: FactorSummary }) {
  return (
    <span className="flex flex-col gap-0.5">
      <span
        className={cn(
          "inline-flex items-center gap-1.5",
          summary.tone === "bad" && "font-semibold text-bad",
          summary.tone === "warn" && "font-semibold text-warn",
          summary.tone === "muted" && "text-muted-foreground"
        )}
      >
        {(summary.tone === "bad" || summary.tone === "warn") && <TriangleAlert aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />}
        {summary.label}
      </span>
      {summary.detail && <span className="text-xs text-soft">{summary.detail}</span>}
    </span>
  );
}

export function UserStatus({ user }: { user: Pick<UserOverviewEntry, "status" | "invited" | "disabledAt"> }) {
  const format = useFormat();
  const status = statusOf(user);
  if (status.kind === "disabled" && user.disabledAt) {
    return (
      <span className="flex flex-col gap-0.5">
        <StatusDot tone="off" label={status.label} className="whitespace-nowrap" />
        <span className="text-xs whitespace-nowrap text-soft" title={format.dateTime(user.disabledAt)}>
          since <span className="num">{format.date(user.disabledAt)}</span>
        </span>
      </span>
    );
  }
  if (status.kind === "invited") {
    return (
      <span className="inline-flex items-center gap-2 whitespace-nowrap text-[13px]">
        <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full border-[1.5px] border-muted-foreground" />
        Invited
      </span>
    );
  }
  return <StatusDot tone={status.kind === "active" ? "ok" : "off"} label={status.label} className="whitespace-nowrap" />;
}

