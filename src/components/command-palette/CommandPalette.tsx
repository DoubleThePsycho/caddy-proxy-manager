"use client";

/**
 * The global command palette (⌘K / Ctrl+K): hosts, certificates, users,
 * actions, pages, settings and documentation from GET /api/v1/search, which
 * limits every group to what the signed-in user may read.
 *
 * Mount CommandPaletteProvider once around the dashboard; anything inside
 * opens it with useCommandPalette().open(). The shortcut is ignored while
 * another modal dialog is open, so the palette never stacks on a form.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { useRouter } from "next/navigation";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { toast } from "sonner";
import {
  ArrowRight,
  FileKey,
  FileText,
  Globe,
  KeyRound,
  Plus,
  RefreshCw,
  Search,
  Server,
  ShieldCheck,
  SlidersHorizontal,
  User,
  UserPlus,
  X,
  type LucideIcon,
} from "lucide-react";
import { Dialog, DialogOverlay, DialogPortal } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { DOCUMENTATION_URL } from "@/src/lib/brand";
import {
  groupSearchResults,
  rememberRecent,
  sanitizeRecentItems,
  splitMatch,
  type RecentItem,
  type SearchGroup,
  type SearchResponse,
  type SearchResult,
  type SearchResultKind,
} from "@/src/lib/search-results";

// ── Context ───────────────────────────────────────────────────────────

export type CommandPaletteApi = {
  /** Opens the palette, optionally with a query already typed. */
  open: (query?: string) => void;
  close: () => void;
};

const NOOP: CommandPaletteApi = { open: () => {}, close: () => {} };
const CommandPaletteContext = createContext<CommandPaletteApi>(NOOP);

/** Opens and closes the palette; a no-op outside CommandPaletteProvider. */
export function useCommandPalette(): CommandPaletteApi {
  return useContext(CommandPaletteContext);
}

/** True when a modal dialog other than the palette is open (the shortcut then does nothing). */
function anotherDialogOpen(): boolean {
  return Boolean(document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]'));
}

export function CommandPaletteProvider({
  children,
  userId = null,
}: {
  children: ReactNode;
  /**
   * The signed-in user. Recent results are remembered per user in this
   * browser; without it nothing is remembered, so one user never sees
   * another's recent hosts on a shared browser.
   */
  userId?: string | number | null;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [initialQuery, setInitialQuery] = useState("");
  const [session, setSession] = useState(0);

  const api = useMemo<CommandPaletteApi>(
    () => ({
      open: (query = "") => {
        setInitialQuery(query);
        setSession((value) => value + 1);
        setIsOpen(true);
      },
      close: () => setIsOpen(false),
    }),
    []
  );

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== "k") return;
      if (isOpen) {
        event.preventDefault();
        setIsOpen(false);
        return;
      }
      if (anotherDialogOpen()) return;
      event.preventDefault();
      api.open();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [api, isOpen]);

  return (
    <CommandPaletteContext.Provider value={api}>
      {children}
      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        {isOpen && <PaletteDialog key={session} initialQuery={initialQuery} userId={userId} onClose={() => setIsOpen(false)} />}
      </Dialog>
    </CommandPaletteContext.Provider>
  );
}

// ── Items ─────────────────────────────────────────────────────────────

/** A row of the palette: a search result, or a remembered one (group "recent"). */
export type PaletteItem = Omit<SearchResult, "group"> & { group: SearchGroup };

const KIND_LABELS: Record<SearchResultKind, string> = {
  proxy_host: "Proxy host",
  l4_proxy_host: "L4 host",
  certificate: "Certificate",
  user: "User",
  action: "Action",
  page: "Page",
  setting: "Setting",
  doc: "Documentation",
};

const ACTION_ICONS: Record<string, LucideIcon> = {
  "action:create-proxy-host": Plus,
  "action:create-proxy-host:domain": Plus,
  "action:add-access-list": KeyRound,
  "action:import-certificate": FileKey,
  "action:add-user": UserPlus,
  "action:apply-config": RefreshCw,
};

const KIND_ICONS: Record<SearchResultKind, LucideIcon> = {
  proxy_host: Globe,
  l4_proxy_host: Server,
  certificate: ShieldCheck,
  user: User,
  action: Plus,
  page: ArrowRight,
  setting: SlidersHorizontal,
  doc: FileText,
};

function iconFor(item: PaletteItem): LucideIcon {
  return (item.kind === "action" && ACTION_ICONS[item.id]) || KIND_ICONS[item.kind];
}

function recentToItem(item: RecentItem): PaletteItem {
  return { ...item, group: "recent", subtitle: KIND_LABELS[item.kind], run: null, verb: item.kind === "doc" ? "Read" : "Open" };
}

/**
 * The rows in the order the palette shows them: grouped (Recent, Hosts,
 * Certificates, Users, Actions, Go to, Settings, Documentation), suggestions
 * already in Recent left out.
 */
export function orderPaletteItems(results: readonly SearchResult[], recent: readonly RecentItem[] = []): PaletteItem[] {
  const recentIds = new Set(recent.map((item) => item.id));
  const items: PaletteItem[] = [...recent.map(recentToItem), ...results.filter((result) => !recentIds.has(result.id))];
  return groupSearchResults(items).flatMap((group) => group.results);
}

function recentKey(userId: string | number): string {
  return `ingressi:command-palette:recent:${userId}`;
}

function readRecent(userId: string | number | null): RecentItem[] {
  if (userId === null || userId === "") return [];
  try {
    return sanitizeRecentItems(JSON.parse(window.localStorage.getItem(recentKey(userId)) ?? "[]"), DOCUMENTATION_URL);
  } catch {
    return [];
  }
}

function writeRecent(userId: string | number | null, items: RecentItem[]): void {
  if (userId === null || userId === "") return;
  try {
    window.localStorage.setItem(recentKey(userId), JSON.stringify(items));
  } catch {
    // Browser storage is a convenience only.
  }
}

// ── Dialog ────────────────────────────────────────────────────────────

async function applyConfiguration(): Promise<void> {
  const response = await fetch("/api/v1/caddy/apply", { method: "POST", headers: { "content-type": "application/json" } });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
    throw new Error(typeof body?.error === "string" ? body.error : `The request failed (${response.status})`);
  }
}

function PaletteDialog({ initialQuery, userId, onClose }: { initialQuery: string; userId: string | number | null; onClose: () => void }) {
  const router = useRouter();
  const idPrefix = useId().replace(/:/g, "");
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState(initialQuery);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [status, setStatus] = useState<"loading" | "idle" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [recent, setRecent] = useState<RecentItem[]>([]);
  const first = useRef(true);

  useEffect(() => {
    setRecent(readRecent(userId));
  }, [userId]);

  useEffect(() => {
    const controller = new AbortController();
    const delay = first.current ? 0 : 120;
    first.current = false;
    setStatus("loading");
    const timer = window.setTimeout(() => void (async () => {
      try {
        const response = await fetch(`/api/v1/search?q=${encodeURIComponent(query)}`, { signal: controller.signal, headers: { accept: "application/json" } });
        if (!response.ok) throw new Error(`The search failed (${response.status})`);
        const body = (await response.json()) as SearchResponse;
        if (controller.signal.aborted) return;
        setResults(Array.isArray(body.results) ? body.results : []);
        setError(null);
        setStatus("idle");
      } catch (err) {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : "The search failed");
        setStatus("error");
      }
    })(), delay);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  const items = useMemo(() => orderPaletteItems(results, query.trim() ? [] : recent), [results, recent, query]);
  const activeIndex = items.length === 0 ? -1 : Math.min(Math.max(0, active), items.length - 1);

  useEffect(() => {
    if (activeIndex < 0) return;
    document.getElementById(`${idPrefix}-option-${activeIndex}`)?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, idPrefix]);

  const activate = useCallback(
    async (item: PaletteItem) => {
      if (userId !== null) {
        const next = rememberRecent(recent, item);
        setRecent(next);
        writeRecent(userId, next);
      }
      onClose();
      if (item.run === "apply_config") {
        const pending = toast.loading("Applying the configuration…");
        try {
          await applyConfiguration();
          toast.success("Configuration applied to Caddy", { id: pending });
        } catch (err) {
          toast.error(err instanceof Error ? err.message : "Applying the configuration failed", { id: pending });
        }
        return;
      }
      if (item.external) {
        window.open(item.href, "_blank", "noopener,noreferrer");
        return;
      }
      router.push(item.href);
    },
    [onClose, recent, router, userId]
  );

  function onKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (items.length === 0) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((activeIndex + step + items.length) % items.length);
    } else if (event.key === "Home" && items.length > 0 && event.ctrlKey) {
      event.preventDefault();
      setActive(0);
    } else if (event.key === "End" && items.length > 0 && event.ctrlKey) {
      event.preventDefault();
      setActive(items.length - 1);
    } else if (event.key === "Enter" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      const item = items[activeIndex];
      if (item) void activate(item);
    }
  }

  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        aria-describedby={undefined}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          inputRef.current?.focus();
          inputRef.current?.select();
        }}
        onEscapeKeyDown={(event) => {
          // Escape clears the query first, then closes.
          if (query) {
            event.preventDefault();
            setQuery("");
            setActive(0);
          }
        }}
        className="fixed left-1/2 top-4 z-50 flex max-h-[calc(100dvh-32px)] w-[calc(100%-32px)] max-w-[680px] -translate-x-1/2 flex-col overflow-hidden rounded-[14px] border border-line2 bg-panel text-foreground shadow-overlay focus:outline-none sm:top-[104px] sm:max-h-[calc(100dvh-140px)]"
      >
        <DialogPrimitive.Title className="sr-only">Command palette</DialogPrimitive.Title>
        <CommandPalettePanel
          idPrefix={idPrefix}
          inputRef={inputRef}
          query={query}
          items={items}
          activeIndex={activeIndex}
          status={status}
          error={error}
          onQueryChange={(value) => {
            setQuery(value);
            setActive(0);
          }}
          onClear={() => {
            setQuery("");
            setActive(0);
            inputRef.current?.focus();
          }}
          onKeyDown={onKeyDown}
          onHover={setActive}
          onActivate={(item) => void activate(item)}
        />
      </DialogPrimitive.Content>
    </DialogPortal>
  );
}

// ── Panel (presentational) ────────────────────────────────────────────

const KBD = "num inline-block min-w-[12px] rounded-[5px] border border-b-2 border-line2 bg-panel2 px-[5px] text-center text-[11px] leading-[18px] text-muted-foreground";

export type CommandPalettePanelProps = {
  /** Prefix of the element ids (listbox, groups, options). */
  idPrefix: string;
  inputRef?: RefObject<HTMLInputElement | null>;
  query: string;
  /** Rows in display order (orderPaletteItems). */
  items: readonly PaletteItem[];
  activeIndex: number;
  status: "loading" | "idle" | "error";
  error?: string | null;
  onQueryChange: (value: string) => void;
  onClear: () => void;
  onKeyDown?: (event: ReactKeyboardEvent<HTMLInputElement>) => void;
  onHover?: (index: number) => void;
  onActivate?: (item: PaletteItem) => void;
};

/** The palette's input, grouped results and footer, without the dialog around them. */
export function CommandPalettePanel({
  idPrefix,
  inputRef,
  query,
  items,
  activeIndex,
  status,
  error = null,
  onQueryChange,
  onClear,
  onKeyDown,
  onHover,
  onActivate,
}: CommandPalettePanelProps) {
  const listboxId = `${idPrefix}-results`;
  const inputId = `${idPrefix}-query`;
  const groups = groupSearchResults(items);
  const empty = items.length === 0 && status !== "loading" && query.trim().length > 0;
  let index = 0;

  const onOptionClick = (event: ReactMouseEvent<HTMLAnchorElement>, item: PaletteItem) => {
    // Modified clicks open the link the browser's way (new tab or window).
    if (!item.run && (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0)) return;
    event.preventDefault();
    onActivate?.(item);
  };

  return (
    <>
      <div className="flex h-14 flex-none items-center gap-3 border-b border-line pl-[18px] pr-3">
        <Search aria-hidden="true" className="h-[18px] w-[18px] flex-none text-muted-foreground" strokeWidth={2} />
        <label htmlFor={inputId} className="sr-only">
          Search hosts, actions, settings and documentation
        </label>
        <input
          ref={inputRef}
          id={inputId}
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={activeIndex >= 0 ? `${idPrefix}-option-${activeIndex}` : undefined}
          autoComplete="off"
          spellCheck={false}
          value={query}
          maxLength={200}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Search hosts, actions, settings and docs"
          className="h-full min-w-0 flex-1 border-0 bg-transparent text-[17px] text-foreground outline-none placeholder:text-soft focus-visible:outline-none"
        />
        {query.length > 0 && (
          <button
            type="button"
            onClick={onClear}
            aria-label="Clear the search"
            className="grid h-8 w-8 flex-none place-items-center rounded-lg text-muted-foreground hover:bg-raise hover:text-foreground"
          >
            <X aria-hidden="true" className="h-3.5 w-3.5" strokeWidth={2.4} />
          </button>
        )}
        <kbd className={KBD}>esc</kbd>
      </div>

      <div id={listboxId} role="listbox" aria-label="Results" className="flex min-h-0 flex-col gap-1 overflow-y-auto px-2 pb-2 pt-1.5 sm:max-h-[492px]">
        {groups.map((group) => {
          const headingId = `${idPrefix}-group-${group.group}`;
          return (
            <div key={group.group} role="group" aria-labelledby={headingId} className="flex flex-col gap-px">
              <div id={headingId} className="flex items-center gap-2 px-2.5 pb-1 pt-2.5 text-[11px] font-semibold uppercase leading-4 tracking-[0.06em] text-soft">
                <span>{group.title}</span>
              </div>
              {group.results.map((item) => {
                const position = index++;
                const selected = position === activeIndex;
                const Icon = iconFor(item);
                const parts = item.noHighlight ? { pre: item.title, hit: "", post: "" } : splitMatch(item.title, query);
                return (
                  <a
                    key={`${group.group}:${item.id}`}
                    id={`${idPrefix}-option-${position}`}
                    href={item.href}
                    role="option"
                    aria-selected={selected}
                    tabIndex={-1}
                    target={item.external ? "_blank" : undefined}
                    rel={item.external ? "noopener noreferrer" : undefined}
                    onMouseMove={() => {
                      if (!selected) onHover?.(position);
                    }}
                    onClick={(event) => onOptionClick(event, item)}
                    className={cn(
                      "flex min-h-11 items-center gap-3 rounded-lg px-2.5 text-foreground no-underline outline-none",
                      selected ? "bg-brand-tint" : "hover:text-foreground"
                    )}
                  >
                    <span
                      aria-hidden="true"
                      className={cn(
                        "grid h-7 w-7 flex-none place-items-center rounded-[7px]",
                        selected ? "bg-primary text-primary-foreground" : "bg-raise text-muted-foreground"
                      )}
                    >
                      <Icon className="h-4 w-4" strokeWidth={2} />
                    </span>
                    <span className="flex min-w-0 flex-1 items-baseline gap-2.5">
                      <span className={cn("max-w-[62%] flex-none truncate", item.mono && "num")}>
                        {parts.pre}
                        {parts.hit && (
                          <span className="font-bold underline decoration-brand decoration-2 underline-offset-[3px]">{parts.hit}</span>
                        )}
                        {parts.post}
                      </span>
                      {item.subtitle && <span className="min-w-0 flex-1 truncate text-xs text-soft">{item.subtitle}</span>}
                    </span>
                    {selected && (
                      <span className="flex flex-none items-center gap-1.5 text-xs text-muted-foreground">
                        {item.verb}
                        <kbd className={KBD}>↵</kbd>
                      </span>
                    )}
                  </a>
                );
              })}
            </div>
          );
        })}
        {empty && (
          <div className="flex flex-col items-start gap-2 px-2.5 py-5">
            <p className="m-0 text-muted-foreground">Nothing matches “{query.trim()}”. Try a host name, an action or a setting.</p>
            <button
              type="button"
              onClick={onClear}
              className="h-8 rounded-lg border border-line2 bg-panel2 px-3 text-[13px] hover:bg-raise"
            >
              Clear the search
            </button>
          </div>
        )}
        {status === "error" && error && (
          <p className="m-0 px-2.5 py-2 text-[13px] text-bad">
            {error}. Results may be out of date; keep typing to try again.
          </p>
        )}
      </div>

      <div className="flex flex-none flex-wrap items-center gap-x-[18px] gap-y-2 border-t border-line bg-panel2 px-[18px] py-2.5 text-xs leading-[18px] text-soft">
        <span className="flex items-center gap-1.5">
          <kbd className={KBD}>↑</kbd>
          <kbd className={KBD}>↓</kbd>
          to move
        </span>
        <span className="flex items-center gap-1.5">
          <kbd className={KBD}>↵</kbd>
          to open
        </span>
        <span className="flex items-center gap-1.5">
          <kbd className={KBD}>esc</kbd>
          to close
        </span>
        <span className="ml-auto" role="status">
          {status === "loading" && items.length === 0 ? "Searching…" : items.length === 1 ? "1 result" : `${items.length} results`}
        </span>
      </div>
    </>
  );
}
