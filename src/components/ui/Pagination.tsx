"use client";

/**
 * The pager under a dashboard list: "26–50 of 312 hosts", previous and next,
 * and page numbers (on wider screens). Pages are links (`hrefFor`, the URL's
 * ?page=, so back and reload keep the page) or buttons (`onPageChange`).
 * Renders nothing while everything fits on one page.
 */
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useCallback, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { pageNumbers, parsePageParam } from "@/src/lib/pagination";

export type PaginationProps = {
  page: number;
  perPage: number;
  total: number;
  /** What the rows are, plural ("hosts"); omitted, the range has no noun. */
  noun?: string;
  hrefFor?: (page: number) => string;
  onPageChange?: (page: number) => void;
  /** Accessible name of the pager, e.g. "Pages of hosts". Default "Pages". */
  label?: string;
  className?: string;
};

const ITEM =
  "inline-flex h-8 min-w-8 items-center justify-center rounded-md border border-line2 bg-panel px-2 text-[13px] text-foreground transition-colors hover:bg-raise";
const DISABLED = "pointer-events-none opacity-40";

export function Pagination({ page, perPage, total, noun, hrefFor, onPageChange, label = "Pages", className }: PaginationProps) {
  const pageCount = Math.max(1, Math.ceil(total / perPage));
  if (pageCount <= 1) return null;
  const current = Math.min(pageCount, Math.max(1, page));
  const from = (current - 1) * perPage + 1;
  const to = Math.min(total, current * perPage);

  const item = (target: number, content: ReactNode, props: { ariaLabel?: string; current?: boolean; disabled?: boolean; className?: string }) => {
    const classes = cn(ITEM, props.current && "border-brand bg-brand-tint font-semibold", props.disabled && DISABLED, props.className);
    if (props.disabled) {
      return (
        <span className={classes} aria-disabled="true" aria-label={props.ariaLabel}>
          {content}
        </span>
      );
    }
    if (hrefFor) {
      return (
        <Link href={hrefFor(target)} scroll={false} className={classes} aria-label={props.ariaLabel} aria-current={props.current ? "page" : undefined}>
          {content}
        </Link>
      );
    }
    return (
      <button type="button" onClick={() => onPageChange?.(target)} className={classes} aria-label={props.ariaLabel} aria-current={props.current ? "page" : undefined}>
        {content}
      </button>
    );
  };

  return (
    <nav aria-label={label} className={cn("flex flex-wrap items-center gap-x-3 gap-y-2", className)}>
      <span className="text-[13px] text-muted-foreground">
        <span className="num">{from}</span>–<span className="num">{to}</span> of <span className="num">{total}</span>
        {noun ? ` ${noun}` : ""}
      </span>
      <span className="ml-auto flex items-center gap-1">
        {item(current - 1, <ChevronLeft aria-hidden="true" className="size-4" />, { ariaLabel: "Previous page", disabled: current <= 1 })}
        {pageNumbers(current, pageCount).map((n, index) =>
          n === null ? (
            <span key={`gap-${index}`} aria-hidden="true" className="hidden px-1 text-soft sm:inline">
              …
            </span>
          ) : (
            <span key={n} className={n === current ? undefined : "hidden sm:contents"}>
              {item(n, <span className="num">{n}</span>, { ariaLabel: `Page ${n}`, current: n === current })}
            </span>
          )
        )}
        {item(current + 1, <ChevronRight aria-hidden="true" className="size-4" />, { ariaLabel: "Next page", disabled: current >= pageCount })}
      </span>
    </nav>
  );
}

/**
 * The page a client list shows, kept in the URL (`?page=`, or `param`) so back,
 * reload and shared links keep it, and the link to any page. Other parameters
 * are kept; page 1 drops the parameter.
 */
export function useUrlPage(param = "page"): { page: number; hrefFor: (page: number) => string } {
  const pathname = usePathname() ?? "";
  const search = useSearchParams();
  const query = search?.toString() ?? "";
  const page = parsePageParam(search?.get(param));
  const hrefFor = useCallback(
    (target: number) => {
      const params = new URLSearchParams(query);
      if (target <= 1) params.delete(param);
      else params.set(param, String(target));
      const text = params.toString();
      return text ? `${pathname}?${text}` : pathname;
    },
    [pathname, query, param]
  );
  return { page, hrefFor };
}
