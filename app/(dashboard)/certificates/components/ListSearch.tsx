"use client";

import { Search } from "lucide-react";
import { cn } from "@/lib/utils";

/** The search field of a list on the certificates page. */
export function ListSearch({
  value,
  onChange,
  label,
  placeholder,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  /** Accessible name, e.g. "Search client certificates". */
  label: string;
  placeholder: string;
  className?: string;
}) {
  return (
    <label
      className={cn(
        "flex h-[38px] min-w-0 flex-[1_1_240px] items-center gap-2 rounded-[10px] border border-line bg-panel px-3 text-soft focus-within:border-brand",
        className
      )}
    >
      <Search aria-hidden="true" className="h-4 w-4 shrink-0" />
      <span className="sr-only">{label}</span>
      <input
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="h-full min-w-0 flex-1 border-0 bg-transparent text-sm text-foreground outline-none placeholder:text-soft"
      />
    </label>
  );
}
