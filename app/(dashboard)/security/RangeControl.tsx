"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { cn } from "@/lib/utils";
import type { SecurityRange } from "./security-types";
import { securityHref, type SecurityQuery } from "./security-view";

const PRESETS = ["1h", "24h", "7d", "30d"] as const;
/** The longest custom range the analytics queries accept (src/lib/analytics/range.ts). */
const MAX_CUSTOM_SECONDS = 92 * 86_400;

/** "YYYY-MM-DDTHH:mm" of a Unix time, in UTC (the page shows UTC times). */
export function toUtcInput(unix: number): string {
  const d = new Date(unix * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** A datetime-local value read as UTC (the trailing "Z"), or null. */
export function fromUtcInput(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const ms = new Date(`${value}Z`).getTime();
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/**
 * The page's time range: the presets of the analytics page, or a custom
 * range in UTC. Changing it changes the URL (range, from, to), which the
 * server reads.
 */
export function RangeControl({ query, range, onNavigate }: { query: SecurityQuery; range: SecurityRange; onNavigate: (href: string) => void }) {
  const isCustom = range.preset === "custom";
  const [editing, setEditing] = useState(false);
  const [from, setFrom] = useState(() => toUtcInput(query.from ?? range.start));
  const [to, setTo] = useState(() => toUtcInput(query.to ?? range.end));
  const showFields = isCustom || editing;

  function apply() {
    const fromTs = fromUtcInput(from);
    const toTs = fromUtcInput(to);
    if (fromTs === null || toTs === null || fromTs >= toTs) {
      toast.error("Choose a start before the end.");
      return;
    }
    if (toTs - fromTs > MAX_CUSTOM_SECONDS) {
      toast.error("A custom range can cover at most 92 days.");
      return;
    }
    if (fromTs > Math.floor(Date.now() / 1000)) {
      toast.error("The start is in the future.");
      return;
    }
    setEditing(false);
    onNavigate(securityHref(query, { range: "custom", from: fromTs, to: toTs }));
  }

  return (
    <div className="flex flex-wrap items-center gap-2.5">
      <SegmentedControl
        label="Time range"
        mono
        value={isCustom || editing ? "custom" : range.preset}
        onChange={(value) => {
          setEditing(false);
          onNavigate(securityHref(query, { range: value, from: null, to: null }));
        }}
        options={PRESETS.map((preset) => ({ value: preset, label: preset }))}
        trailing={
          <button
            type="button"
            aria-pressed={showFields}
            onClick={() => {
              if (!isCustom) setEditing((value) => !value);
            }}
            className={cn(
              "inline-flex h-[30px] shrink-0 items-center rounded-[7px] border-0 px-3 text-[13px] transition-colors",
              showFields ? "bg-raise text-foreground" : "bg-transparent text-muted-foreground hover:text-foreground"
            )}
          >
            Custom
          </button>
        }
      />
      {showFields && (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            apply();
          }}
        >
          <Input type="datetime-local" aria-label="From (UTC)" value={from} onChange={(event) => setFrom(event.target.value)} className="num h-9 w-[200px]" />
          <span aria-hidden="true" className="text-soft">
            to
          </span>
          <Input type="datetime-local" aria-label="To (UTC)" value={to} onChange={(event) => setTo(event.target.value)} className="num h-9 w-[200px]" />
          <Button type="submit" size="sm" variant="secondary">
            Apply range
          </Button>
        </form>
      )}
    </div>
  );
}
