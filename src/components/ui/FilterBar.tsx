"use client";

import { useId, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { ChevronLeft, Filter as FilterIcon, Plus, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { SegmentedControl } from "@/components/ui/SegmentedControl";

export type FilterOperator = "is" | "is not";

/** One filter: a dimension (by key), whether it includes or excludes, and the value. */
export type ActiveFilter = {
  /** The dimension's key, e.g. "host". */
  dimension: string;
  operator: FilterOperator;
  value: string;
};

export type FilterDimension = {
  key: string;
  /** Shown in the menu and on chips, e.g. "Host". */
  label: string;
  /** Values offered while typing (the top values of the current view). */
  suggestions?: readonly string[];
  /** Values are addresses, paths or codes: show them in mono. Default true. */
  mono?: boolean;
  /** Placeholder of the value field, e.g. "app.example.com". */
  placeholder?: string;
};

export type FilterChipProps = {
  /** The dimension's label, e.g. "Host". */
  dimension: string;
  operator: FilterOperator;
  value: string;
  /** Shows a remove button (labelled "Remove filter: Host is app.example.com"). */
  onRemove?: () => void;
  /** Mono value. Default true. */
  mono?: boolean;
  className?: string;
};

/** "Host · is · app.example.com": a filter in effect, with an optional remove button. */
export function FilterChip({ dimension, operator, value, onRemove, mono = true, className }: FilterChipProps) {
  return (
    <span
      className={cn(
        "inline-flex h-[30px] max-w-full items-center gap-1.5 rounded-lg border border-line2 bg-panel2 pl-2.5 text-[13px] leading-5",
        onRemove ? "pr-1" : "pr-2.5",
        className
      )}
    >
      <span className="shrink-0 text-muted-foreground">{dimension}</span>
      <span className={cn("shrink-0 font-semibold", operator === "is" ? "text-brand" : "text-waf-ink")}>{operator}</span>
      <span className={cn("min-w-0 truncate", mono && "num")}>{value}</span>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove filter: ${dimension} ${operator} ${value}`}
          className="grid h-[22px] w-[22px] shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-raise hover:text-foreground"
        >
          <X aria-hidden="true" className="h-3 w-3" strokeWidth={2.4} />
        </button>
      )}
    </span>
  );
}

export type FilterBarProps = {
  filters: readonly ActiveFilter[];
  /** What can be filtered on, in menu order. */
  dimensions: readonly FilterDimension[];
  /** Called with a new filter from the add-filter form. Without it there is no add button. */
  onAdd?: (filter: ActiveFilter) => void;
  /** Called when a chip's remove button is pressed. Without it chips have no remove button. */
  onRemove?: (filter: ActiveFilter, index: number) => void;
  /** Content at the end of the row, e.g. the live status and a "Save view" link. */
  trailing?: ReactNode;
  /** Text of the add button. Default "Add filter". */
  addLabel?: string;
  /** Accessible name of the bar. Default "Filters". */
  label?: string;
  className?: string;
};

/**
 * The filter row of a data page: chips for the filters in effect and an
 * "Add filter" button. The button opens a menu of dimensions; picking one
 * shows a small form (is / is not, and the value, with suggestions).
 */
export function FilterBar({
  filters,
  dimensions,
  onAdd,
  onRemove,
  trailing,
  addLabel = "Add filter",
  label = "Filters",
  className,
}: FilterBarProps) {
  const byKey = new Map(dimensions.map((dimension) => [dimension.key, dimension]));
  return (
    <div
      role="group"
      aria-label={label}
      className={cn("flex flex-wrap items-center gap-2 rounded-xl border border-line bg-panel px-2.5 py-2", className)}
    >
      <FilterIcon aria-hidden="true" className="h-4 w-4 shrink-0 text-soft" strokeWidth={2} />
      {filters.map((filter, index) => {
        const dimension = byKey.get(filter.dimension);
        return (
          <FilterChip
            key={`${filter.dimension}-${filter.operator}-${filter.value}-${index}`}
            dimension={dimension?.label ?? filter.dimension}
            operator={filter.operator}
            value={filter.value}
            mono={dimension?.mono ?? true}
            onRemove={onRemove ? () => onRemove(filter, index) : undefined}
          />
        );
      })}
      {onAdd && dimensions.length > 0 && <AddFilter dimensions={dimensions} onAdd={onAdd} label={addLabel} />}
      {trailing && <div className="ml-auto flex flex-wrap items-center gap-3.5 text-[13px] text-soft">{trailing}</div>}
    </div>
  );
}

function AddFilter({ dimensions, onAdd, label }: { dimensions: readonly FilterDimension[]; onAdd: (filter: ActiveFilter) => void; label: string }) {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<FilterDimension | null>(null);
  const [operator, setOperator] = useState<FilterOperator>("is");
  const [value, setValue] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const formId = useId();

  const reset = () => {
    setPicked(null);
    setOperator("is");
    setValue("");
  };

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) reset();
  };

  const moveFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
    if (items.length === 0) return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === "Home" ? 0
        : event.key === "End" ? items.length - 1
          : event.key === "ArrowDown" ? (current + 1) % items.length
            : (current - 1 + items.length) % items.length;
    items[next]?.focus();
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = value.trim();
    if (!picked || !trimmed) return;
    onAdd({ dimension: picked.key, operator, value: trimmed });
    onOpenChange(false);
  };

  const listId = `${formId}-suggestions`;
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex h-[30px] items-center gap-1.5 rounded-lg border border-dashed border-line2 bg-transparent px-2.5 text-[13px] text-muted-foreground transition-colors hover:bg-raise hover:text-foreground"
        >
          <Plus aria-hidden="true" className="h-[13px] w-[13px]" strokeWidth={2.4} />
          {label}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={6} className="w-[260px] p-1.5">
        {picked === null ? (
          <div ref={listRef} onKeyDown={moveFocus} className="flex flex-col">
            <div className="px-2.5 pt-1 pb-1.5 text-xs text-soft" id={`${formId}-heading`}>
              Filter by
            </div>
            <div role="group" aria-labelledby={`${formId}-heading`} className="flex max-h-72 flex-col overflow-y-auto">
              {dimensions.map((dimension) => (
                <button
                  key={dimension.key}
                  type="button"
                  onClick={() => setPicked(dimension)}
                  className="h-8 shrink-0 rounded-md px-2.5 text-left text-[13px] transition-colors hover:bg-raise focus-visible:bg-raise"
                >
                  {dimension.label}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-2.5 p-1.5" aria-label={`Filter by ${picked.label}`}>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setPicked(null)}
                aria-label="Back to the dimensions"
                className="-ml-1 grid h-6 w-6 place-items-center rounded-md text-muted-foreground hover:bg-raise hover:text-foreground"
              >
                <ChevronLeft aria-hidden="true" className="h-4 w-4" />
              </button>
              <span className="text-[13px] font-semibold">{picked.label}</span>
            </div>
            <SegmentedControl
              size="sm"
              label="Match"
              value={operator}
              onChange={setOperator}
              options={[
                { value: "is", label: "is" },
                { value: "is not", label: "is not" },
              ]}
              className="self-start"
            />
            <Input
              autoFocus
              aria-label={`${picked.label} value`}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder={picked.placeholder}
              list={picked.suggestions && picked.suggestions.length > 0 ? listId : undefined}
              className={cn("h-8", (picked.mono ?? true) && "num")}
              autoComplete="off"
              spellCheck={false}
            />
            {picked.suggestions && picked.suggestions.length > 0 && (
              <datalist id={listId}>
                {picked.suggestions.map((suggestion) => (
                  <option key={suggestion} value={suggestion} />
                ))}
              </datalist>
            )}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={!value.trim()}>
                Add
              </Button>
            </div>
          </form>
        )}
      </PopoverContent>
    </Popover>
  );
}
