"use client";

/**
 * Saved views (/api/v1/analytics/views): a menu to open one, a dialog to
 * save the current settings, and one to rename, share, update, copy a link
 * to, or delete them. The API decides who may change what; the buttons
 * only follow it (the owner changes a view; an administrator may also
 * delete a shared one).
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Bookmark, ChevronDown, Link2, Pencil, RefreshCw, Trash2, Users } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/EmptyState";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import type { AnalyticsSavedView } from "@/src/lib/models/analytics-views";
import { savedViewSettings, serializeViewState, stateFromSavedView, type ViewState } from "./view-state";

const VIEWS_URL = "/api/v1/analytics/views";
const MAX_NAME = 100;

async function send(method: "POST" | "PATCH" | "DELETE", url: string, body?: unknown): Promise<unknown> {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const reported = data && typeof data === "object" && "error" in data ? String((data as { error: unknown }).error ?? "") : "";
    throw new Error(reported || `The request failed (HTTP ${response.status})`);
  }
  return data;
}

function isView(value: unknown): value is AnalyticsSavedView {
  return Boolean(value) && typeof value === "object" && typeof (value as AnalyticsSavedView).id === "number" && typeof (value as AnalyticsSavedView).name === "string";
}

export type SavedViewsApi = {
  views: AnalyticsSavedView[];
  loading: boolean;
  error: string | null;
  reload: () => void;
  create: (name: string, shared: boolean, state: ViewState) => Promise<AnalyticsSavedView>;
  change: (id: number, patch: Record<string, unknown>) => Promise<AnalyticsSavedView>;
  remove: (id: number) => Promise<void>;
};

/** The caller's saved views and the shared ones of their organisation. */
export function useSavedViews(enabled: boolean): SavedViewsApi {
  const [views, setViews] = useState<AnalyticsSavedView[]>([]);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    setLoading(true);
    fetch(VIEWS_URL, { headers: { Accept: "application/json" } })
      .then(async (response) => {
        const data: unknown = await response.json().catch(() => null);
        if (!response.ok) throw new Error(`Saved views could not be loaded (HTTP ${response.status})`);
        if (!Array.isArray(data)) throw new Error("Saved views could not be loaded");
        if (active) {
          setViews(data.filter(isView));
          setError(null);
        }
      })
      .catch((failure: unknown) => {
        if (active) setError(failure instanceof Error ? failure.message : "Saved views could not be loaded");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [enabled, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);

  const create = useCallback(
    async (name: string, shared: boolean, state: ViewState) => {
      const view = await send("POST", VIEWS_URL, { name, shared, ...savedViewSettings(state) });
      if (!isView(view)) throw new Error("The view was saved but the answer was not understood");
      reload();
      return view;
    },
    [reload]
  );

  const change = useCallback(
    async (id: number, patch: Record<string, unknown>) => {
      const view = await send("PATCH", `${VIEWS_URL}/${id}`, patch);
      if (!isView(view)) throw new Error("The view was changed but the answer was not understood");
      setViews((current) => current.map((v) => (v.id === id ? view : v)));
      return view;
    },
    []
  );

  const remove = useCallback(async (id: number) => {
    await send("DELETE", `${VIEWS_URL}/${id}`);
    setViews((current) => current.filter((v) => v.id !== id));
  }, []);

  return { views, loading, error, reload, create, change, remove };
}

/** The page link of a saved view's settings. */
export function savedViewHref(view: AnalyticsSavedView): string {
  const query = serializeViewState(stateFromSavedView(view));
  return `/analytics${query ? `?${query}` : ""}`;
}

async function copyLink(view: AnalyticsSavedView) {
  const url = new URL(savedViewHref(view), window.location.origin).toString();
  try {
    await navigator.clipboard.writeText(url);
    toast.success(`Link to "${view.name}" copied`);
  } catch {
    toast.error("The link could not be copied");
  }
}

/** The header's "Views" menu: open a saved view, save the current settings, manage views. */
export function SavedViewsMenu({
  api,
  activeView,
  onOpen,
  onSave,
  onManage,
}: {
  api: SavedViewsApi;
  /** The view the page shows, when it is unchanged. */
  activeView: AnalyticsSavedView | null;
  onOpen: (view: AnalyticsSavedView) => void;
  onSave: () => void;
  onManage: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" className="max-w-[240px]">
          <Bookmark aria-hidden="true" />
          <span className="truncate">{activeView ? activeView.name : "Views"}</span>
          <ChevronDown aria-hidden="true" className="text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel>Saved views</DropdownMenuLabel>
        {api.loading && api.views.length === 0 ? (
          <p className="m-0 px-2 py-1.5 text-[13px] text-soft">Loading…</p>
        ) : api.error ? (
          <p className="m-0 px-2 py-1.5 text-[13px] text-bad">{api.error}</p>
        ) : api.views.length === 0 ? (
          <p className="m-0 px-2 py-1.5 text-[13px] text-soft">No saved views yet.</p>
        ) : (
          <div className="max-h-72 overflow-y-auto">
            {api.views.map((view) => (
              <DropdownMenuItem key={view.id} onSelect={() => onOpen(view)} className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate">{view.name}</span>
                {view.shared && (
                  <span className="shrink-0 text-xs text-soft">{view.owned ? "Shared" : view.ownerName ? `by ${view.ownerName}` : "Shared"}</span>
                )}
              </DropdownMenuItem>
            ))}
          </div>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onSave}>Save current view…</DropdownMenuItem>
        <DropdownMenuItem onSelect={onManage}>Manage views…</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Saves the current settings under a name. */
export function SaveViewDialog({
  open,
  onOpenChange,
  api,
  state,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  api: SavedViewsApi;
  state: ViewState;
  onSaved: (view: AnalyticsSavedView) => void;
}) {
  const [name, setName] = useState("");
  const [shared, setShared] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setName("");
      setShared(false);
      setError(null);
    }
  }, [open]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Enter a name.");
      return;
    }
    setSaving(true);
    try {
      const view = await api.create(trimmed, shared, state);
      toast.success(`View "${view.name}" saved`);
      onSaved(view);
      onOpenChange(false);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The view could not be saved");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Save view</DialogTitle>
            <DialogDescription>Saves the time range, filters, metric and grouping under a name.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="analytics-view-name">Name</Label>
            <Input
              id="analytics-view-name"
              value={name}
              maxLength={MAX_NAME}
              onChange={(event) => setName(event.target.value)}
              placeholder="Errors on the API hosts"
              autoFocus
            />
          </div>
          <label className="flex items-start gap-3 text-[13px]">
            <Switch checked={shared} onCheckedChange={setShared} className="mt-0.5" />
            <span className="flex flex-col gap-0.5">
              <span className="font-medium">Share with other users</span>
              <span className="text-muted-foreground">Everyone in your organisation who can read analytics can open it. Only you can change it.</span>
            </span>
          </label>
          {error && (
            <p role="alert" className="m-0 text-[13px] text-bad">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? "Saving…" : "Save view"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** One saved view in the manage dialog, with what its owner (or an administrator) may do. */
function ManagedView({
  view,
  isAdmin,
  api,
  state,
  onOpen,
}: {
  view: AnalyticsSavedView;
  isAdmin: boolean;
  api: SavedViewsApi;
  state: ViewState;
  onOpen: (view: AnalyticsSavedView) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(view.name);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const mayDelete = view.owned || (isAdmin && view.shared);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    try {
      await work();
    } catch (failure) {
      toast.error(failure instanceof Error ? failure.message : "The view could not be changed");
    } finally {
      setBusy(false);
    }
  };

  const rename = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || trimmed === view.name) {
      setRenaming(false);
      return;
    }
    void run(async () => {
      await api.change(view.id, { name: trimmed });
      setRenaming(false);
      toast.success("View renamed");
    });
  };

  return (
    <li className="flex flex-col gap-2 border-b border-line py-3 last:border-b-0">
      {renaming ? (
        <form onSubmit={rename} className="flex items-center gap-2">
          <Input
            aria-label={`New name for ${view.name}`}
            value={name}
            maxLength={MAX_NAME}
            onChange={(event) => setName(event.target.value)}
            className="h-8"
            autoFocus
          />
          <Button type="submit" size="sm" disabled={busy}>
            Rename
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setRenaming(false)}>
            Cancel
          </Button>
        </form>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => onOpen(view)}
            className="min-w-0 truncate text-left text-sm font-medium text-foreground hover:text-brand"
          >
            {view.name}
          </button>
          {view.shared && (
            <Badge variant="muted" className="gap-1">
              <Users aria-hidden="true" className="size-3" />
              Shared
            </Badge>
          )}
          {!view.owned && view.ownerName && <span className="text-xs text-soft">by {view.ownerName}</span>}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        {view.owned && !renaming && (
          <Button
            size="sm"
            variant="ghost"
            aria-label={`Rename ${view.name}`}
            onClick={() => {
              setName(view.name);
              setRenaming(true);
            }}
            disabled={busy}
          >
            <Pencil aria-hidden="true" />
            Rename
          </Button>
        )}
        {view.owned && (
          <label className="inline-flex h-8 items-center gap-2 px-2 text-[13px] text-muted-foreground">
            <Switch
              aria-label={`Share ${view.name} with other users`}
              checked={view.shared}
              disabled={busy}
              onCheckedChange={(next) =>
                void run(async () => {
                  await api.change(view.id, { shared: next });
                  toast.success(next ? "View shared" : "View no longer shared");
                })
              }
            />
            Shared
          </label>
        )}
        {view.owned && (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            aria-label={`Save the current settings to ${view.name}`}
            onClick={() =>
              void run(async () => {
                await api.change(view.id, savedViewSettings(state));
                toast.success(`"${view.name}" now saves the current settings`);
              })
            }
          >
            <RefreshCw aria-hidden="true" />
            Save current settings to it
          </Button>
        )}
        <Button size="sm" variant="ghost" aria-label={`Copy link to ${view.name}`} onClick={() => void copyLink(view)}>
          <Link2 aria-hidden="true" />
          Copy link
        </Button>
        {mayDelete &&
          (confirmDelete ? (
            <span className="inline-flex items-center gap-1.5">
              <Button
                size="sm"
                variant="danger"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await api.remove(view.id);
                    toast.success(`View "${view.name}" deleted`);
                  })
                }
              >
                Delete
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>
                Keep
              </Button>
            </span>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(true)} aria-label={`Delete ${view.name}`}>
              <Trash2 aria-hidden="true" />
              Delete
            </Button>
          ))}
      </div>
    </li>
  );
}

/** Rename, share, update, copy a link to, or delete saved views. */
export function ManageViewsDialog({
  open,
  onOpenChange,
  api,
  isAdmin,
  state,
  onOpen,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  api: SavedViewsApi;
  isAdmin: boolean;
  state: ViewState;
  onOpen: (view: AnalyticsSavedView) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Saved views</DialogTitle>
          <DialogDescription>Your views and the ones others in your organisation shared. Only the person who saved a view changes it.</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {api.error ? (
            <p role="alert" className="m-0 text-[13px] text-bad">
              {api.error}
            </p>
          ) : api.views.length === 0 ? (
            <EmptyState compact icon={Bookmark} title="No saved views yet" description="Save the current range and filters to come back to them." />
          ) : (
            <ul className="m-0 list-none p-0">
              {api.views.map((view) => (
                <ManagedView
                  key={view.id}
                  view={view}
                  isAdmin={isAdmin}
                  api={api}
                  state={state}
                  onOpen={(v) => {
                    onOpen(v);
                    onOpenChange(false);
                  }}
                />
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
