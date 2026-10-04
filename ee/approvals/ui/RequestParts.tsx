// SPDX-License-Identifier: Elastic-2.0
import type { ReactNode } from "react";
import { badgeVariants } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { PillTone } from "./request-format";
import { initials } from "./request-format";

/** A status pill that can sit inside a button (a span, unlike Badge). */
export function Pill({ tone, children, className }: { tone: PillTone; children: ReactNode; className?: string }) {
  return <span className={cn(badgeVariants({ variant: tone }), "font-semibold", className)}>{children}</span>;
}

/** A round avatar with two initials. */
export function Initials({ name, size = "sm" }: { name: string; size?: "xs" | "sm" | "md" }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "grid shrink-0 place-items-center rounded-full bg-raise font-semibold text-foreground",
        size === "xs" && "h-[18px] w-[18px] text-[9px]",
        size === "sm" && "h-5 w-5 text-[9px]",
        size === "md" && "h-[26px] w-[26px] text-[10px]"
      )}
    >
      {initials(name)}
    </span>
  );
}
