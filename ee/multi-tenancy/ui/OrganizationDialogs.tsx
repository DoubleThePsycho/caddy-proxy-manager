// SPDX-License-Identifier: Elastic-2.0
"use client";

import { Badge } from "@/components/ui/badge";
import { Banner } from "@/components/ui/Banner";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { AppDialog } from "@/components/ui/AppDialog";
import { SearchField } from "@/components/ui/SearchField";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { OrganizationView } from "@/ee/multi-tenancy/service";
import { MOVABLE_KINDS, type MovableRows } from "@/ee/multi-tenancy/types";

export type Draft = {
  name: string;
  slug: string;
  enabled: boolean;
  maxProxyHosts: string;
  maxUsers: string;
  allowedUpstreams: string;
  notes: string;
};

export function draftOf(organization: OrganizationView | null): Draft {
  return {
    name: organization?.name ?? "",
    slug: organization?.slug ?? "",
    enabled: organization?.enabled ?? true,
    maxProxyHosts: organization?.maxProxyHosts?.toString() ?? "",
    maxUsers: organization?.maxUsers?.toString() ?? "",
    allowedUpstreams: (organization?.allowedUpstreams ?? []).join("\n"),
    notes: organization?.notes ?? "",
  };
}

function limitValue(text: string): number | null {
  const trimmed = text.trim();
  return trimmed === "" ? null : Number(trimmed);
}

/** The request body of a create or change, as the REST API takes it. */
export function draftBody(draft: Draft) {
  return {
    name: draft.name,
    ...(draft.slug.trim() ? { slug: draft.slug.trim() } : {}),
    enabled: draft.enabled,
    maxProxyHosts: limitValue(draft.maxProxyHosts),
    maxUsers: limitValue(draft.maxUsers),
    allowedUpstreams: draft.allowedUpstreams.split(/[\n,]/).map((item) => item.trim()).filter(Boolean),
    notes: draft.notes.trim() || null,
  };
}

function DialogError({ error }: { error: string | null }) {
  return error ? (
    <Banner tone="bad" live>
      {error}
    </Banner>
  ) : null;
}

export function OrganizationEditDialog({
  open,
  creating,
  draft,
  onDraftChange,
  onClose,
  onSave,
  pending,
  error,
}: {
  open: boolean;
  creating: boolean;
  draft: Draft;
  onDraftChange: (draft: Draft) => void;
  onClose: () => void;
  onSave: () => void;
  pending: boolean;
  error: string | null;
}) {
  return (
    <AppDialog
      open={open}
      onClose={onClose}
      title={creating ? "New organisation" : "Edit organisation"}
      maxWidth="md"
      onSubmit={onSave}
      submitLabel={creating ? "Create" : "Save"}
      isSubmitting={pending}
    >
      <div className="flex flex-col gap-4">
        <DialogError error={error} />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="organization-name">Name</Label>
            <Input id="organization-name" value={draft.name} onChange={(event) => onDraftChange({ ...draft, name: event.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="organization-slug">Slug</Label>
            <Input
              id="organization-slug"
              className="num"
              value={draft.slug}
              placeholder="From the name"
              onChange={(event) => onDraftChange({ ...draft, slug: event.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="organization-max-hosts">Proxy host limit</Label>
            <Input
              id="organization-max-hosts"
              className="num"
              inputMode="numeric"
              placeholder="No limit"
              value={draft.maxProxyHosts}
              onChange={(event) => onDraftChange({ ...draft, maxProxyHosts: event.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="organization-max-users">User limit</Label>
            <Input
              id="organization-max-users"
              className="num"
              inputMode="numeric"
              placeholder="No limit"
              value={draft.maxUsers}
              onChange={(event) => onDraftChange({ ...draft, maxUsers: event.target.value })}
            />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="organization-upstreams">Allowed upstreams</Label>
          <Textarea
            id="organization-upstreams"
            className="num"
            rows={4}
            placeholder={"app.example.com\n*.svc.example.com\n10.20.0.0/16"}
            value={draft.allowedUpstreams}
            onChange={(event) => onDraftChange({ ...draft, allowedUpstreams: event.target.value })}
          />
          <p className="text-xs text-soft">
            Where the organisation&apos;s own users may proxy to, one per line: host names, *.wildcards, IP addresses or CIDRs.
            Empty allows nothing; &quot;*&quot; allows any address, including other tenants&apos; backends and your internal services.
          </p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="organization-notes">Notes</Label>
          <Textarea id="organization-notes" rows={2} value={draft.notes} onChange={(event) => onDraftChange({ ...draft, notes: event.target.value })} />
        </div>
        <div className="flex items-center gap-2">
          <Switch id="organization-enabled" checked={draft.enabled} onCheckedChange={(checked) => onDraftChange({ ...draft, enabled: checked })} />
          <Label htmlFor="organization-enabled">Enabled (a disabled organisation&apos;s users cannot sign in)</Label>
        </div>
      </div>
    </AppDialog>
  );
}

export function OrganizationDeleteDialog({
  organization,
  onClose,
  onDelete,
  pending,
  error,
}: {
  organization: OrganizationView | null;
  onClose: () => void;
  onDelete: () => void;
  pending: boolean;
  error: string | null;
}) {
  return (
    <AppDialog open={organization !== null} onClose={onClose} title="Delete organisation" onSubmit={onDelete} submitLabel="Delete" isSubmitting={pending}>
      <div className="flex flex-col gap-3 text-sm">
        <DialogError error={error} />
        <p>
          Delete &quot;{organization?.name}&quot;? An organisation that still owns proxy hosts, certificates, access lists, groups or
          users cannot be deleted: move or delete them first.
        </p>
      </div>
    </AppDialog>
  );
}

export const PROVIDER = "provider";

export function OrganizationMoveDialog({
  moving,
  organizations,
  movable,
  selected,
  filter,
  onFilterChange,
  onDestinationChange,
  onToggleRow,
  onClose,
  onMove,
  pending,
  error,
}: {
  /** "provider" or an organisation id; null when closed. */
  moving: string | null;
  organizations: readonly OrganizationView[];
  movable: MovableRows;
  selected: Record<string, Set<number>>;
  filter: string;
  onFilterChange: (value: string) => void;
  onDestinationChange: (value: string) => void;
  onToggleRow: (kind: string, id: number, checked: boolean) => void;
  onClose: () => void;
  onMove: () => void;
  pending: boolean;
  error: string | null;
}) {
  const names = new Map(organizations.map((organization) => [organization.id, organization.name]));
  const destinationId = moving === null || moving === PROVIDER ? null : Number(moving);
  const needle = filter.trim().toLowerCase();
  const selectedCount = MOVABLE_KINDS.reduce((sum, kind) => sum + (selected[kind.key]?.size ?? 0), 0);
  const groups = MOVABLE_KINDS.map((kind) => ({
    kind,
    rows: movable[kind.key].filter(
      (row) =>
        row.organizationId !== destinationId &&
        (!needle || row.label.toLowerCase().includes(needle) || (row.detail ?? "").toLowerCase().includes(needle))
    ),
  }));
  const ownerLabel = (organizationId: number | null) => (organizationId === null ? "Provider" : names.get(organizationId) ?? `#${organizationId}`);
  return (
    <AppDialog
      open={moving !== null}
      onClose={onClose}
      title={moving === PROVIDER ? "Move to the provider level" : `Move into ${names.get(destinationId ?? 0) ?? ""}`}
      maxWidth="xl"
      onSubmit={onMove}
      submitLabel={`Move ${selectedCount} item(s)`}
      isSubmitting={pending || selectedCount === 0}
    >
      <div className="flex flex-col gap-4">
        <DialogError error={error} />
        <p className="text-sm text-muted-foreground">
          A host moves together with its certificate and access list. Moved users get a role that fits: an administrator becomes
          an organisation admin, and moving out of an organisation leaves a viewer. Group members and forward-auth grants that
          would cross organisations are removed.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <SearchField
            aria-label="Filter rows"
            placeholder="Filter…"
            value={filter}
            onChange={(event) => onFilterChange(event.target.value)}
            className="w-full max-w-xs"
          />
          {moving !== null && moving !== PROVIDER && (
            <Select value={moving} onValueChange={onDestinationChange}>
              <SelectTrigger className="w-56" aria-label="Destination organisation">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {organizations.map((organization) => (
                  <SelectItem key={organization.id} value={String(organization.id)}>
                    {organization.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
        {groups.every(({ rows }) => rows.length === 0) && (
          <p className="text-sm text-soft">{needle ? "No rows match the filter." : "Nothing to move: every row already belongs here."}</p>
        )}
        {groups.map(({ kind, rows }) => {
          if (rows.length === 0) return null;
          return (
            <div key={kind.key} className="space-y-2">
              <div className="text-sm font-semibold">{kind.label}</div>
              <div className="max-h-48 divide-y divide-line overflow-y-auto rounded-lg border border-line">
                {rows.map((row) => {
                  const id = `move-${kind.key}-${row.id}`;
                  return (
                    <label key={row.id} htmlFor={id} className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm hover:bg-panel2">
                      <Checkbox
                        id={id}
                        checked={selected[kind.key]?.has(row.id) ?? false}
                        onCheckedChange={(checked) => onToggleRow(kind.key, row.id, checked === true)}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="font-medium">{row.label}</span>
                        {row.detail && <span className="num ml-2 break-all text-xs text-soft">{row.detail}</span>}
                      </span>
                      <Badge variant="outline">{ownerLabel(row.organizationId)}</Badge>
                    </label>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </AppDialog>
  );
}
