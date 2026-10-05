/**
 * Paging for dashboard lists: the page a URL asks for, clamped to the pages
 * there are, the slice it shows and the page numbers to offer. Pure, so the
 * server pages and the client lists share it.
 */

/** Rows per page of a dashboard list. */
export const DEFAULT_PAGE_SIZE = 25;

export type PageSlice<T> = {
  items: T[];
  /** 1-based, within 1..pageCount. */
  page: number;
  pageCount: number;
  total: number;
  perPage: number;
  /** 1-based positions of the first and last row shown; 0 and 0 when there are none. */
  from: number;
  to: number;
};

/** A page number from a URL parameter: a positive integer, else 1. */
export function parsePageParam(value: string | readonly string[] | null | undefined): number {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string" || !/^\d{1,6}$/.test(raw)) return 1;
  return Math.max(1, Number(raw));
}

/** The rows of `requestedPage`, clamped to the last page (an empty list has one, empty, page). */
export function paginate<T>(items: readonly T[], requestedPage: number, perPage: number = DEFAULT_PAGE_SIZE): PageSlice<T> {
  const total = items.length;
  const pageCount = Math.max(1, Math.ceil(total / perPage));
  const page = Math.min(pageCount, Math.max(1, Math.floor(requestedPage) || 1));
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  return { items: slice, page, pageCount, total, perPage, from: total === 0 ? 0 : start + 1, to: start + slice.length };
}

/**
 * The page numbers to show: the first and last page, the current one and its
 * neighbours, with null for a gap ("1 … 4 5 6 … 12").
 */
export function pageNumbers(page: number, pageCount: number): (number | null)[] {
  const shown = new Set([1, pageCount, page - 1, page, page + 1].filter((n) => n >= 1 && n <= pageCount));
  // A gap of one page shows that page instead of an ellipsis.
  if (shown.has(3) && pageCount >= 3) shown.add(2);
  if (shown.has(pageCount - 2) && pageCount >= 3) shown.add(pageCount - 1);
  const sorted = [...shown].sort((a, b) => a - b);
  const out: (number | null)[] = [];
  for (const n of sorted) {
    const last = out[out.length - 1];
    if (typeof last === "number" && n - last > 1) out.push(null);
    out.push(n);
  }
  return out;
}
