"use client";

import { useState } from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { formatDayUtc } from "./chart-format";

export type ExpiryTone = "ok" | "warn" | "bad";

export type ExpiryItem = {
  id: string;
  /** What expires: a domain, a certificate's name. */
  label: string;
  /** Whole days until it expires; negative once expired. */
  daysLeft: number;
  /** Extra line in the tooltip and accessible text ("Renews from 4 Oct", "DNS-01"). */
  detail?: string;
  /** Overrides the tone derived from daysLeft. */
  tone?: ExpiryTone;
  /** Makes the marker a link. */
  href?: string;
};

export type ExpiryTimelineProps = {
  items: readonly ExpiryItem[];
  /** The list's accessible name. Default "Expiry, next 90 days" (follows maxDays). */
  title?: string;
  /** Length of the axis in days. Default 90. */
  maxDays?: number;
  /** The renewal band, from today to this many days. Default 30. */
  renewalDays?: number;
  /** Under this many days left an item is urgent (red). Default 7. */
  urgentDays?: number;
  /** Days between axis ticks. Default 30 (15 when `now` is given). */
  tickStep?: number;
  /** Today. With it, ticks show dates ("18 Oct") instead of day counts. */
  now?: number | Date;
  /** Formats a tick's label. Overrides the default day count or date. */
  formatTick?: (days: number) => string;
  /** Shows the colour legend above the axis. Default true. */
  legend?: boolean;
  okLabel?: string;
  warnLabel?: string;
  urgentLabel?: string;
  renewalLabel?: string;
  /** Second line in the band. Default "Under 30 days left" (follows renewalDays). */
  renewalNote?: string;
  /** The selected marker (outlined). */
  selectedId?: string | null;
  /** Makes markers toggle buttons (aria-pressed). Ignored for items with an href. */
  onSelect?: (item: ExpiryItem) => void;
  /** Minimum plot height in px; it grows with tall stacks. Default 184. */
  height?: number;
  className?: string;
};

/** The tone of an item `daysLeft` from expiry: expired or urgent (bad), in the renewal band (warn), else ok. */
export function expiryTone(daysLeft: number, renewalDays = 30, urgentDays = 7): ExpiryTone {
  if (daysLeft < urgentDays) return "bad";
  if (daysLeft <= renewalDays) return "warn";
  return "ok";
}

/** "expired 3 days ago", "expires today", "1 day left", "42 days left". */
export function expiryText(daysLeft: number): string {
  if (daysLeft < 0) return `expired ${-daysLeft} day${daysLeft === -1 ? "" : "s"} ago`;
  if (daysLeft === 0) return "expires today";
  return `${daysLeft} day${daysLeft === 1 ? "" : "s"} left`;
}

const TONE_BG: Record<ExpiryTone, string> = { ok: "bg-ok", warn: "bg-warn", bad: "bg-bad" };
const TONE_TEXT: Record<ExpiryTone, string> = { ok: "text-foreground", warn: "text-warn", bad: "text-bad" };
const STACK_STEP = 15;
const AXIS_BOTTOM = 28;

type Placed = { item: ExpiryItem; tone: ExpiryTone; position: number; stack: number };

/**
 * Places items on the axis: clamped to 0…maxDays, markers closer than about
 * 1.5% of the axis gathered into one stack at their average position.
 */
export function placeExpiryItems(
  items: readonly ExpiryItem[],
  { maxDays = 90, renewalDays = 30, urgentDays = 7 }: { maxDays?: number; renewalDays?: number; urgentDays?: number } = {}
): Placed[] {
  const sorted = items
    .map((item) => ({ item, day: Math.min(maxDays, Math.max(0, item.daysLeft)) }))
    .sort((a, b) => a.day - b.day || a.item.daysLeft - b.item.daysLeft || a.item.label.localeCompare(b.item.label));
  const width = maxDays / 60;
  const clusters: { first: number; members: typeof sorted }[] = [];
  for (const entry of sorted) {
    const last = clusters[clusters.length - 1];
    if (last && entry.day - last.first <= width) last.members.push(entry);
    else clusters.push({ first: entry.day, members: [entry] });
  }
  return clusters.flatMap((cluster) => {
    const day = cluster.members.reduce((sum, m) => sum + m.day, 0) / cluster.members.length;
    return cluster.members.map((m, stack) => ({
      item: m.item,
      tone: m.item.tone ?? expiryTone(m.item.daysLeft, renewalDays, urgentDays),
      position: maxDays > 0 ? day / maxDays : 0,
      stack,
    }));
  });
}

const pct = (fraction: number) => `${(fraction * 100).toFixed(3)}%`;

/**
 * Upcoming expiries on a 0–90 day axis, as on the certificates page: a
 * tinted renewal band, one marker per item coloured by urgency, close
 * markers stacked, expired items pinned at today. The markers form an
 * ordered list (soonest first), so screen readers read every item.
 */
export function ExpiryTimeline({
  items,
  title,
  maxDays = 90,
  renewalDays = 30,
  urgentDays = 7,
  tickStep,
  now,
  formatTick,
  legend = true,
  okLabel = "Renews on schedule",
  warnLabel = "Due for renewal",
  urgentLabel = `Expired or under ${urgentDays} days`,
  renewalLabel = "Renewal window",
  renewalNote,
  selectedId = null,
  onSelect,
  height = 184,
  className,
}: ExpiryTimelineProps) {
  const [focused, setFocused] = useState<string | null>(null);
  const placed = placeExpiryItems(items, { maxDays, renewalDays, urgentDays });
  const tallest = placed.reduce((max, p) => Math.max(max, p.stack + 1), 0);
  const plotHeight = Math.max(height, AXIS_BOTTOM + 4 + tallest * STACK_STEP + 64);
  const expired = items.filter((i) => i.daysLeft < 0).length;
  const nowMs = now === undefined ? null : typeof now === "number" ? now : now.getTime();
  const step = tickStep ?? (nowMs === null ? 30 : 15);
  const ticks: number[] = [];
  for (let d = 0; d <= maxDays; d += Math.max(1, step)) ticks.push(d);
  if (ticks[ticks.length - 1] !== maxDays) ticks.push(maxDays);
  const tickLabel =
    formatTick ??
    ((days: number) => {
      if (nowMs !== null) return days === 0 ? `${formatDayUtc(nowMs)} · today` : formatDayUtc(nowMs + days * 86_400_000);
      return days === 0 ? "Today" : `${days} days`;
    });
  const hovered = placed.find((p) => p.item.id === focused) ?? null;
  const band = Math.min(1, Math.max(0, renewalDays / maxDays));

  return (
    <div className={cn("flex min-w-0 flex-col gap-3", className)}>
      {legend && (
        <div className="flex flex-wrap gap-3.5 text-xs text-muted-foreground">
          {(
            [
              ["ok", okLabel],
              ["warn", warnLabel],
              ["bad", urgentLabel],
            ] as const
          ).map(([tone, text]) => (
            <span key={tone} className="flex items-center gap-1.5">
              <span aria-hidden="true" className={cn("size-2.5 rounded-full", TONE_BG[tone])} />
              {text}
            </span>
          ))}
        </div>
      )}
      <div className="relative overflow-x-auto overflow-y-hidden">
        <div className="relative mx-2 min-w-[600px]" style={{ height: plotHeight }} onMouseLeave={() => setFocused(null)}>
          <div aria-hidden="true" className="absolute left-0 top-0 rounded-t-lg bg-warn-tint" style={{ width: pct(band), bottom: AXIS_BOTTOM }} />
          <div className="pointer-events-none absolute left-2.5 top-2 flex flex-col text-xs">
            <span className="font-semibold text-warn">{renewalLabel}</span>
            <span className="text-muted-foreground">{renewalNote ?? `Under ${renewalDays} days left`}</span>
            {expired > 0 && (
              <span className="text-bad" data-testid="expired-note">
                {expired} already expired
              </span>
            )}
          </div>
          <div aria-hidden="true" className="absolute inset-x-0 border-t border-line2" style={{ bottom: AXIS_BOTTOM }} />
          {ticks.map((d) => {
            const p = d / maxDays;
            return (
              <div key={d} aria-hidden="true">
                <div className="absolute h-2 border-l border-line2" style={{ left: pct(p), bottom: AXIS_BOTTOM - 8 }} />
                <span
                  className="num absolute bottom-0 whitespace-nowrap text-[11px] text-soft"
                  style={{ left: pct(p), transform: d === 0 ? "none" : d === maxDays ? "translateX(-100%)" : "translateX(-50%)" }}
                >
                  {tickLabel(d)}
                </span>
              </div>
            );
          })}

          <ol aria-label={title ?? `Expiry, next ${maxDays} days`} className="m-0 list-none p-0">
            {placed.map((p) => {
              const text = `${p.item.label}: ${expiryText(p.item.daysLeft)}${p.item.detail ? `, ${p.item.detail}` : ""}`;
              const selected = selectedId === p.item.id;
              const dot = cn(
                "block size-3 rounded-full border-2 transition-transform hover:scale-125 focus-visible:scale-125",
                TONE_BG[p.tone],
                selected ? "border-foreground" : "border-panel"
              );
              const handlers = {
                onMouseEnter: () => setFocused(p.item.id),
                onFocus: () => setFocused(p.item.id),
                onBlur: () => setFocused(null),
              };
              return (
                <li
                  key={p.item.id}
                  data-tone={p.tone}
                  data-position={pct(p.position)}
                  className="absolute -translate-x-1/2"
                  style={{ left: pct(p.position), bottom: AXIS_BOTTOM + 4 + p.stack * STACK_STEP }}
                >
                  {p.item.href ? (
                    <Link href={p.item.href} aria-label={text} className={dot} {...handlers} />
                  ) : onSelect ? (
                    <button
                      type="button"
                      aria-label={text}
                      aria-pressed={selected}
                      onClick={() => onSelect(p.item)}
                      className={cn(dot, "cursor-pointer p-0")}
                      {...handlers}
                    />
                  ) : (
                    <span className={dot} onMouseEnter={handlers.onMouseEnter}>
                      <span className="sr-only">{text}</span>
                    </span>
                  )}
                </li>
              );
            })}
          </ol>

          {hovered && (
            <div
              aria-hidden="true"
              className="pointer-events-none absolute z-10 flex w-[236px] flex-col gap-1 rounded-[10px] border border-line2 bg-panel px-3 py-2.5 shadow-overlay"
              style={{
                left: pct(hovered.position),
                bottom: AXIS_BOTTOM + 4 + (hovered.stack + 1) * STACK_STEP + 6,
                transform: hovered.position > 2 / 3 ? "translateX(calc(-100% - 14px))" : "translateX(14px)",
              }}
              data-testid="expiry-tooltip"
            >
              <span className={cn("num text-[13px] font-semibold", TONE_TEXT[hovered.tone])}>{hovered.item.label}</span>
              <span className="text-xs text-muted-foreground">{expiryText(hovered.item.daysLeft)}</span>
              {hovered.item.detail && <span className="text-xs text-muted-foreground">{hovered.item.detail}</span>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
