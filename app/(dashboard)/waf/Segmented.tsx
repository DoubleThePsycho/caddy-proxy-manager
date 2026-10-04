"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * A row of mutually exclusive options (a radio group drawn as joined
 * buttons). Disabled through an enclosing fieldset or `disabled`.
 */
export function Segmented({
  value,
  onChange,
  options,
  labelledBy,
  label,
  disabled,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: ReactNode; count?: number }[];
  labelledBy?: string;
  label?: string;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-labelledby={labelledBy}
      aria-label={labelledBy ? undefined : label}
      className={cn("flex w-fit max-w-full flex-wrap gap-0.5 rounded-lg border bg-background p-0.5", className)}
    >
      {options.map((option) => {
        const checked = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={checked}
            disabled={disabled}
            onClick={() => onChange(option.value)}
            className={cn(
              "flex h-[30px] items-center gap-1.5 whitespace-nowrap rounded-md px-3 text-sm transition-colors disabled:cursor-not-allowed",
              checked ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"
            )}
          >
            {option.label}
            {option.count !== undefined && <span className="font-mono text-muted-foreground">{option.count.toLocaleString("en-US")}</span>}
          </button>
        );
      })}
    </div>
  );
}
