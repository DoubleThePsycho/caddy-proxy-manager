// SPDX-License-Identifier: Elastic-2.0
"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Banner } from "@/components/ui/Banner";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { AppDialog } from "@/components/ui/AppDialog";
import type { PermissionCatalogue } from "@/ee/custom-roles/catalogue";

type ActionResult = { ok: true } | { ok: false; error: string };

export type RoleEditorActor = {
  isAdmin: boolean;
  /** Permissions the signed-in user holds (all of them for administrators). */
  permissions: string[];
  /** The tag scope of the signed-in user's own role, if any. */
  scopeTags: string[];
  /** The id of the signed-in user's own custom role, which they cannot edit. */
  customRoleId: number | null;
};

/** What the editor starts from: a role to change (id set), or a new one (id null, possibly copied from another). */
export type RoleDraft = { id: number | null; name: string; description: string; permissions: Set<string>; scopeTags: string };

export function isAdminLevelSet(catalogue: PermissionCatalogue, permissions: Iterable<string>): boolean {
  const held = new Set(permissions);
  return (
    catalogue.adminLevel.permissions.some((permission) => held.has(permission)) ||
    catalogue.adminLevel.combinations.some((combination) => combination.every((permission) => held.has(permission)))
  );
}

/**
 * The role editor: name, description, tag scope and the permission matrix.
 * The server checks every rule again (license, escalation, unscoped-only
 * permissions); the controls here only steer.
 */
export default function RoleEditorDialog({
  initial,
  catalogue,
  actor,
  saveRole,
  onClose,
}: {
  initial: RoleDraft;
  catalogue: PermissionCatalogue;
  actor: RoleEditorActor;
  saveRole: (id: number | null, input: unknown) => Promise<ActionResult>;
  onClose: () => void;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState<RoleDraft>(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const held = new Set(actor.permissions);

  function toggle(area: string, action: string, actions: string[], checked: boolean) {
    const next = new Set(draft.permissions);
    const permission = `${area}:${action}`;
    if (checked) {
      next.add(permission);
      // Changing something includes seeing it.
      if (action !== "read" && actions.includes("read")) next.add(`${area}:read`);
    } else {
      next.delete(permission);
      if (action === "read") for (const other of actions) if (other !== "read") next.delete(`${area}:${other}`);
    }
    setDraft({ ...draft, permissions: next });
  }

  function save() {
    setError(null);
    const input = {
      name: draft.name,
      description: draft.description || null,
      permissions: [...draft.permissions],
      scopeTags: draft.scopeTags.split(",").map((tag) => tag.trim()).filter(Boolean),
    };
    startTransition(async () => {
      try {
        const result = await saveRole(draft.id, input);
        if (!result.ok) {
          setError(result.error);
          return;
        }
        onClose();
        router.refresh();
      } catch {
        setError("Failed to save the role");
      }
    });
  }

  const adminLevel = isAdminLevelSet(catalogue, draft.permissions);

  return (
    <AppDialog
      open
      onClose={onClose}
      title={draft.id === null ? "Create role" : `Edit role ${initial.name}`}
      maxWidth="xl"
      submitLabel="Save role"
      onSubmit={save}
      isSubmitting={pending}
    >
      <div className="flex flex-col gap-4">
        {error && (
          <Banner tone="bad" live>
            <span data-testid="role-error">{error}</span>
          </Banner>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="role-name">Name</Label>
            <Input
              id="role-name"
              value={draft.name}
              maxLength={64}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              data-testid="role-name"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="role-scope">Tag scope</Label>
            <Input
              id="role-scope"
              value={draft.scopeTags}
              placeholder="Every host"
              autoCapitalize="none"
              spellCheck={false}
              className="num"
              onChange={(event) => setDraft({ ...draft, scopeTags: event.target.value })}
              data-testid="role-scope"
            />
            <p className="text-xs text-muted-foreground">
              Comma-separated tags. When set, the scoped permissions only reach hosts carrying one of them.
            </p>
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="role-description">Description</Label>
          <Textarea
            id="role-description"
            value={draft.description}
            rows={2}
            maxLength={500}
            onChange={(event) => setDraft({ ...draft, description: event.target.value })}
          />
        </div>
        {adminLevel && (
          <Banner tone="warn">This role is administrator-level: only administrators can create, change or assign it.</Banner>
        )}
        <div className="divide-y divide-line rounded-xl border border-line" data-testid="permission-matrix">
          {catalogue.areas.map((area) => {
            const actions = area.permissions.map((permission) => permission.slice(area.area.length + 1));
            return (
              <div key={area.area} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-sm font-medium">{area.label}</span>
                    {area.scopable && <Badge variant="info">tag scope applies</Badge>}
                    {area.instanceWide && <Badge variant="muted">every host</Badge>}
                  </div>
                  <p className="text-xs text-muted-foreground">{area.description}</p>
                </div>
                <div className="flex shrink-0 flex-wrap gap-3">
                  {actions.map((action) => {
                    const permission = `${area.area}:${action}`;
                    const adminOnly = catalogue.adminLevel.permissions.includes(permission);
                    const notHeld = !actor.isAdmin && (!held.has(permission) || adminOnly);
                    const id = `perm-${area.area}-${action}`;
                    return (
                      <label key={action} htmlFor={id} className="num flex items-center gap-1.5 text-[13px]">
                        <Checkbox
                          id={id}
                          checked={draft.permissions.has(permission)}
                          disabled={notHeld && !draft.permissions.has(permission)}
                          onCheckedChange={(checked) => toggle(area.area, action, actions, checked === true)}
                          data-testid={id}
                        />
                        {action}
                      </label>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
        <p className="text-xs text-muted-foreground">
          You can only grant permissions you hold yourself{actor.scopeTags.length > 0 ? `, limited to your tags (${actor.scopeTags.join(", ")})` : ""}.
          A role with a tag scope cannot hold {catalogue.unscopedOnly.join(", ")}.
        </p>
      </div>
    </AppDialog>
  );
}
