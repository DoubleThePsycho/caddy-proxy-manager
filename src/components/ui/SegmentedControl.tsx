"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type SegmentedOption<T extends string = string> = {
  value: T;
  label: ReactNode;
  disabled?: boolean;
  /** Accessible name when `label` is not plain text (an icon, say). */
  ariaLabel?: string;
};

export type SegmentedControlProps<T extends string = string> = {
  /** The pressed option. */
  value: T;
  onChange: (value: T) => void;
  options: readonly SegmentedOption<T>[];
  /** Names the group for screen readers, e.g. "Time range". */
  label: string;
  /** sm: 26px buttons (inside cards); md: 30px (page toolbars). Default "md". */
  size?: "sm" | "md";
  /** Mono labels with tabular figures (time ranges such as 1h, 24h). */
  mono?: boolean;
  /** Extra content after the options inside the same frame, e.g. a "Custom" range button. */
  trailing?: ReactNode;
  disabled?: boolean;
  className?: string;
};

/**
 * A row of mutually exclusive buttons in one frame (time ranges, group by,
 * diff layout). Each button carries aria-pressed; the group is labelled.
 */
export function SegmentedControl<T extends string = string>({
  value,
  onChange,
  options,
  label,
  size = "md",
  mono = false,
  trailing,
  disabled = false,
  className,
}: SegmentedControlProps<T>) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn(
        "inline-flex max-w-full items-center gap-0.5 overflow-x-auto rounded-[10px] border border-line bg-panel p-[3px] scrollbar-none",
        size === "sm" && "rounded-[9px]",
        className
      )}
    >
      {options.map((option) => {
        const pressed = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={pressed}
            aria-label={option.ariaLabel}
            disabled={disabled || option.disabled}
            onClick={() => {
              if (!pressed) onChange(option.value);
            }}
            className={cn(
              "inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap border-0 text-[13px] transition-colors",
              "disabled:cursor-not-allowed disabled:opacity-45",
              size === "sm" ? "h-[26px] rounded-[6px] px-2.5" : "h-[30px] rounded-[7px] px-3",
              mono && "num",
              pressed ? "bg-raise text-foreground" : "bg-transparent text-muted-foreground hover:text-foreground"
            )}
          >
            {option.label}
          </button>
        );
      })}
      {trailing}
    </div>
  );
}
