/**
 * The shape of the dashboard search (GET /api/v1/search, src/lib/search.ts)
 * and the pure helpers the command palette uses on it. No database access:
 * safe for client components.
 */

export const SEARCH_GROUPS = ["recent", "hosts", "certificates", "users", "actions", "pages", "settings", "docs"] as const;
export type SearchGroup = (typeof SEARCH_GROUPS)[number];

export const SEARCH_GROUP_TITLES: Record<SearchGroup, string> = {
  recent: "Recent",
  hosts: "Hosts",
  certificates: "Certificates",
  users: "Users",
  actions: "Actions",
  pages: "Go to",
  settings: "Settings",
  docs: "Documentation",
};

export const SEARCH_RESULT_KINDS = ["proxy_host", "l4_proxy_host", "certificate", "user", "action", "page", "setting", "doc"] as const;
export type SearchResultKind = (typeof SEARCH_RESULT_KINDS)[number];

/** Actions the palette runs itself instead of opening a page. */
export const SEARCH_RUN_ACTIONS = ["apply_config"] as const;
export type SearchRunAction = (typeof SEARCH_RUN_ACTIONS)[number];

export type SearchResult = {
  group: Exclude<SearchGroup, "recent">;
  kind: SearchResultKind;
  /** Stable across searches, e.g. "proxy_host:12" or "setting:geoblock". */
  id: string;
  title: string;
  subtitle: string | null;
  /** A dashboard path ("/proxy-hosts?search=…") or, for external documentation, an https URL. */
  href: string;
  /** Opens outside the dashboard (documentation), in a new tab. */
  external: boolean;
  /** The title is a host name or address: shown in the mono face. */
  mono: boolean;
  /** Set for actions the palette runs (href is then the page to fall back to). */
  run: SearchRunAction | null;
  /** The verb next to the selected row: Open, Run or Read. */
  verb: "Open" | "Run" | "Read";
  /** The title is not a match of the query (no highlighted part), e.g. "Create a proxy host" for a domain. */
  noHighlight?: boolean;
};

export type SearchResponse = { query: string; results: SearchResult[] };

/** Results per group for a query. */
export const SEARCH_LIMITS = {
  proxyHosts: 5,
  l4Hosts: 3,
  certificates: 4,
  users: 4,
  actions: 4,
  pages: 4,
  settings: 4,
  docs: 3,
} as const;

/** Longest query the search looks at; longer input is cut. */
export const MAX_SEARCH_QUERY_LENGTH = 100;

export function normalizeSearchQuery(raw: string | null | undefined): string {
  return (raw ?? "").trim().replace(/\s+/g, " ").slice(0, MAX_SEARCH_QUERY_LENGTH);
}

/** The title split around the first case-insensitive occurrence of the query, for highlighting. */
export function splitMatch(title: string, query: string): { pre: string; hit: string; post: string } {
  const q = query.trim().toLowerCase();
  const index = q ? title.toLowerCase().indexOf(q) : -1;
  if (index < 0) return { pre: title, hit: "", post: "" };
  return { pre: title.slice(0, index), hit: title.slice(index, index + q.length), post: title.slice(index + q.length) };
}

export type SearchResultGroup<T> = { group: SearchGroup; title: string; results: T[] };

/** Results grouped in the palette's order, empty groups dropped; order inside a group is kept. */
export function groupSearchResults<T extends { group: SearchGroup }>(results: readonly T[]): SearchResultGroup<T>[] {
  return SEARCH_GROUPS.map((group) => ({ group, title: SEARCH_GROUP_TITLES[group], results: results.filter((result) => result.group === group) }))
    .filter((entry) => entry.results.length > 0);
}

/** What the palette remembers of an opened result (browser storage, per viewer). */
export type RecentItem = Pick<SearchResult, "id" | "kind" | "title" | "href" | "external" | "mono">;

export const MAX_RECENT_ITEMS = 5;

/**
 * Validates recent items read back from browser storage: anything malformed
 * is dropped, hrefs must be dashboard paths ("/…", not "//…") or start with
 * `documentationBase`, titles are cut, duplicates and extra items removed.
 */
export function sanitizeRecentItems(raw: unknown, documentationBase: string): RecentItem[] {
  if (!Array.isArray(raw)) return [];
  const out: RecentItem[] = [];
  const seen = new Set<string>();
  for (const value of raw) {
    if (out.length >= MAX_RECENT_ITEMS) break;
    if (!value || typeof value !== "object") continue;
    const item = value as Record<string, unknown>;
    const { id, kind, title, href } = item;
    if (typeof id !== "string" || id.length > 200 || seen.has(id)) continue;
    if (typeof kind !== "string" || !(SEARCH_RESULT_KINDS as readonly string[]).includes(kind)) continue;
    if (typeof title !== "string" || !title.trim()) continue;
    if (typeof href !== "string" || href.length > 2000) continue;
    const internal = href.startsWith("/") && !href.startsWith("//") && !href.startsWith("/\\");
    const documentation = href.startsWith(`${documentationBase}/`);
    if (!internal && !documentation) continue;
    seen.add(id);
    out.push({
      id,
      kind: kind as SearchResultKind,
      title: title.slice(0, 200),
      href,
      external: documentation,
      mono: item.mono === true,
    });
  }
  return out;
}

/** The recent list after opening `item`: it moves to the front. Client-run actions are not remembered. */
export function rememberRecent(list: readonly RecentItem[], item: RecentItem & Pick<SearchResult, "run">): RecentItem[] {
  if (item.run) return [...list];
  const entry: RecentItem = { id: item.id, kind: item.kind, title: item.title, href: item.href, external: item.external, mono: item.mono };
  return [entry, ...list.filter((existing) => existing.id !== item.id)].slice(0, MAX_RECENT_ITEMS);
}
