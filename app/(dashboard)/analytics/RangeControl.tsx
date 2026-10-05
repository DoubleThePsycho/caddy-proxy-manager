"use client";

import { useState, type FormEvent } from "react";
import { CalendarDays } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import type { RangePreset } from "@/src/lib/analytics";
import { formatDateTimeShortUtc, fromDateTimeInput, toDateTimeInput } from "./present";
import { MAX_RANGE_SECONDS, RANGE_PRESETS, type RangeKey } from "./view-state";

/** Why a custom range is not valid, or null. */
export function customRangeError(from: number | null, to: number | null, now: number): string | null {
  if (from === null || to === null) return "Enter both times.";
  if (to <= from) return "The end must be after the start.";
  if (from > now) return "The start is in the future.";
  if (to - from > MAX_RANGE_SECONDS) return "A range can cover at most 92 days.";
  return null;
}

/**
 * The time range: the presets, and "Custom" with a popover to pick a start
 * and end in UTC.
 */
export function RangeControl({
  range,
  from,
  to,
  onPreset,
  onCustom,
}: {
  range: RangeKey;
  from: number | null;
  to: number | null;
  onPreset: (preset: RangePreset) => void;
  onCustom: (from: number, to: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [error, setError] = useState<string | null>(null);
  const custom = range === "custom" && from !== null && to !== null ? { from, to } : null;

  const onOpenChange = (next: boolean) => {
    if (next) {
      const now = Math.floor(Date.now() / 1000);
      setStart(toDateTimeInput(custom ? custom.from : now - 86_400));
      setEnd(toDateTimeInput(custom ? custom.to : now));
      setError(null);
    }
    setOpen(next);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const now = Math.floor(Date.now() / 1000);
    const a = fromDateTimeInput(start);
    const b = fromDateTimeInput(end);
    const problem = customRangeError(a, b, now);
    if (problem) {
      setError(problem);
      return;
    }
    onCustom(a as number, b as number);
    setOpen(false);
  };

  return (
    <SegmentedControl<RangeKey>
      label="Time range"
      mono
      value={range}
      onChange={(value) => {
        if (value !== "custom") onPreset(value);
      }}
      options={RANGE_PRESETS.map((preset) => ({ value: preset, label: preset }))}
      trailing={
        <Popover open={open} onOpenChange={onOpenChange}>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-pressed={custom !== null}
              className={cn(
                "inline-flex h-[30px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[7px] border-0 px-2.5 text-[13px] transition-colors",
                custom ? "bg-raise text-foreground" : "bg-transparent text-muted-foreground hover:bg-raise hover:text-foreground"
              )}
            >
              <CalendarDays aria-hidden="true" className="size-3.5" />
              {custom ? <span className="num">{`${formatDateTimeShortUtc(custom.from)} – ${formatDateTimeShortUtc(custom.to)}`}</span> : "Custom"}
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-[300px] p-4">
            <form onSubmit={submit} className="flex flex-col gap-3" aria-label="Custom time range">
              <p className="m-0 text-[13px] font-semibold">Custom range (UTC)</p>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="analytics-range-from">From</Label>
                <Input
                  id="analytics-range-from"
                  type="datetime-local"
                  className="num h-9"
                  value={start}
                  onChange={(event) => setStart(event.target.value)}
                  required
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="analytics-range-to">To</Label>
                <Input
                  id="analytics-range-to"
                  type="datetime-local"
                  className="num h-9"
                  value={end}
                  onChange={(event) => setEnd(event.target.value)}
                  required
                />
              </div>
              <p className="m-0 text-xs text-soft">Up to 92 days.</p>
              {error && (
                <p role="alert" className="m-0 text-xs text-bad">
                  {error}
                </p>
              )}
              <div className="flex justify-end gap-2">
                <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
                <Button type="submit" size="sm">
                  Apply
                </Button>
              </div>
            </form>
          </PopoverContent>
        </Popover>
      }
    />
  );
}
