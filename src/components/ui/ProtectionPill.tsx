import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** The protections a host can carry, each with its fixed colour from the traffic palette. */
export type ProtectionKind = "waf" | "sso" | "rate-limit" | "geo" | "mtls" | "access-list" | "forward-auth";

export type ProtectionPillProps = {
  /** Picks the dot colour. Ignored when `color` is given. */
  kind?: ProtectionKind;
  /** Any CSS colour for the dot (a token such as "var(--served)"), instead of `kind`. */
  color?: string;
  /** The text, e.g. "WAF · Block" or "Geo · EU only". */
  label: ReactNode;
  /** Shown as a native tooltip, for the detail behind a short label. */
  title?: string;
  className?: string;
};

const KIND_DOT: Record<ProtectionKind, string> = {
  waf: "bg-waf",
  sso: "bg-brand",
  "rate-limit": "bg-rl",
  geo: "bg-access",
  mtls: "bg-served",
  "access-list": "bg-access",
  "forward-auth": "bg-brand",
};

/** A small outlined pill naming one protection on a host: a coloured dot and a label. */
export function ProtectionPill({ kind, color, label, title, className }: ProtectionPillProps) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex h-[22px] max-w-full items-center gap-1.5 whitespace-nowrap rounded-full border border-line2 px-2 text-xs leading-none text-foreground",
        className
      )}
    >
      <span
        aria-hidden="true"
        className={cn("h-1.5 w-1.5 shrink-0 rounded-full", !color && (kind ? KIND_DOT[kind] : "bg-soft"))}
        style={color ? { background: color } : undefined}
      />
      <span className="truncate">{label}</span>
    </span>
  );
}
