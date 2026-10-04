// SPDX-License-Identifier: Elastic-2.0
"use client";

import { Fragment, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronRight, Plus } from "lucide-react";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useBranding } from "@/ee/white-label/ui/BrandingProvider";
import type { CustomRoleView } from "@/ee/custom-roles/store";
import type { PermissionCatalogue, PermissionCatalogueArea } from "@/ee/custom-roles/catalogue";
import { cn } from "@/lib/utils";
import RoleEditorDialog, { type RoleDraft, type RoleEditorActor } from "./RoleEditorDialog";

export type { RoleEditorActor } from "./RoleEditorDialog";

type ActionResult = { ok: true } | { ok: false; error: string };

type Props = {
  roles: CustomRoleView[];
  catalogue: PermissionCatalogue;
  actor: RoleEditorActor;
  /** Who holds each role, by name: the built-in roles and each custom role by id. */
  holders?: { admin: string[]; user: string[]; viewer: string[]; custom: Record<number, string[]> };
  canWrite: boolean;
  /** The license allows creating, changing and assigning custom roles. */
  licensed: boolean;
  editionLabel: string;
  saveRole: (id: number | null, input: unknown) => Promise<ActionResult>;
  deleteRole: (id: number) => Promise<ActionResult>;
  /** The row open at first: "admin", "user", "viewer" or "custom-<id>". */
  initialOpen?: string | null;
};

/**
 * Areas of the permission catalogue grouped as the sidebar groups the pages.
 * An area this list does not name lands in Other, so a new area always shows.
 */
const FAMILIES: { title: string; areas: readonly string[] }[] = [
  { title: "Traffic", areas: ["proxy_hosts", "l4_proxy_hosts", "certificates", "access_lists"] },
  { title: "Observe", areas: ["analytics", "waf", "alerts", "audit_log", "audit_streaming", "ai"] },
  { title: "Identity", areas: ["users", "groups", "sso", "mfa_policy", "ldap", "scim", "access_reviews"] },
  { title: "Govern", areas: ["approvals", "config_history", "compliance"] },
  {
    title: "Platform",
    areas: ["settings", "instances", "fleet", "high_availability", "backups", "config", "organizations", "monetization", "branding", "usage_reports", "license"],
  },
];

type Family = { title: string; areas: PermissionCatalogueArea[] };

function familiesOf(catalogue: PermissionCatalogue): Family[] {
  const named = new Set(FAMILIES.flatMap((family) => family.areas));
  const byName = new Map(catalogue.areas.map((area) => [area.area, area]));
  const families: Family[] = FAMILIES.map((family) => ({
    title: family.title,
    areas: family.areas.flatMap((name) => byName.get(name) ?? []),
  }));
  families.push({ title: "Other", areas: catalogue.areas.filter((area) => !named.has(area.area)) });
  return families.filter((family) => family.areas.length > 0);
}

type RoleRow = {
  key: string;
  name: string;
  kind: "Built-in" | "Custom";
  adminLevel: boolean;
  description: string;
  permissions: Set<string>;
  scopeTags: string[];
  /** For built-in roles: what the scope column says. */
  scopeText: string;
  holders: string[];
  userCount: number;
  detail: string;
  custom: CustomRoleView | null;
};

function listHolders(names: string[]): string {
  if (names.length === 0) return "nobody";
  return names.length > 6 ? `${names.slice(0, 6).join(", ")} and ${names.length - 6} more` : names.join(", ");
}

/**
 * The Roles tab of Users and groups: the built-in roles described, and
 * custom roles with their permissions grouped by area, their tag scope and
 * who holds them; create, edit, duplicate and delete for users:write.
 */
export default function RolesTab({ roles, catalogue, actor, holders, canWrite, licensed, editionLabel, saveRole, deleteRole, initialOpen = null }: Props) {
  const router = useRouter();
  const { productName } = useBranding();
  const [open, setOpen] = useState<string | null>(initialOpen);
  const [draft, setDraft] = useState<RoleDraft | null>(null);
  const [deleting, setDeleting] = useState<CustomRoleView | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const canEdit = canWrite && licensed;
  const total = catalogue.areas.reduce((sum, area) => sum + area.permissions.length, 0);
  const families = familiesOf(catalogue);
  const adminLevelPermissions = new Set(catalogue.adminLevel.permissions);

  const rows: RoleRow[] = [
    {
      key: "admin",
      name: "Admin",
      kind: "Built-in",
      adminLevel: true,
      description: "Every permission, never limited by tags.",
      permissions: new Set(catalogue.areas.flatMap((area) => area.permissions)),
      scopeTags: [],
      scopeText: "Every host",
      holders: holders?.admin ?? [],
      userCount: holders?.admin.length ?? 0,
      detail:
        `Holds all ${total} permissions in the ${catalogue.areas.length} areas, including the administrator-level ones: ` +
        "single sign-on, the MFA policy, directories, SCIM, the license, access reviews and approval policies.",
      custom: null,
    },
    {
      key: "user",
      name: "User",
      kind: "Built-in",
      adminLevel: false,
      description: "Their own profile, API tokens and the overview page.",
      permissions: new Set(),
      scopeTags: [],
      scopeText: "None",
      holders: holders?.user ?? [],
      userCount: holders?.user.length ?? 0,
      detail: "No permission from the catalogue. What a user reaches behind forward auth depends on their groups, not on this role.",
      custom: null,
    },
    {
      key: "viewer",
      name: "Viewer",
      kind: "Built-in",
      adminLevel: false,
      description: "Same as User. Users of a deleted custom role fall back to it.",
      permissions: new Set(),
      scopeTags: [],
      scopeText: "None",
      holders: holders?.viewer ?? [],
      userCount: holders?.viewer.length ?? 0,
      detail: "No permission from the catalogue. Revoking a role in an access review sets it to Viewer.",
      custom: null,
    },
    ...roles.map((role): RoleRow => {
      const held = new Set<string>(role.permissions);
      const untouched = catalogue.areas.filter((area) => !area.permissions.some((permission) => held.has(permission)));
      const parts = [`Not granted: ${untouched.length} of ${catalogue.areas.length} areas.`];
      if (role.scopeTags.length > 0) {
        parts.push(`A role limited to tags cannot export, import or restore the configuration, or reach hosts without its tags.`);
      }
      if (role.adminLevel) parts.push("Administrator-level: only administrators can change or assign it.");
      return {
        key: `custom-${role.id}`,
        name: role.name,
        kind: "Custom",
        adminLevel: role.adminLevel,
        description: role.description ?? "No description.",
        permissions: held,
        scopeTags: role.scopeTags,
        scopeText: "Every host",
        holders: holders?.custom[role.id] ?? [],
        userCount: role.userCount,
        detail: parts.join(" "),
        custom: role,
      };
    }),
  ];

  function startDraft(role: CustomRoleView | null, copy = false) {
    setDraft(
      role
        ? {
            id: copy ? null : role.id,
            name: copy ? `Copy of ${role.name}`.slice(0, 64) : role.name,
            description: role.description ?? "",
            permissions: new Set(role.permissions),
            scopeTags: role.scopeTags.join(", "),
          }
        : { id: null, name: "", description: "", permissions: new Set(), scopeTags: "" }
    );
  }

  function remove(role: CustomRoleView) {
    setListError(null);
    startTransition(async () => {
      try {
        const result = await deleteRole(role.id);
        if (!result.ok) setListError(result.error);
        else router.refresh();
      } catch {
        setListError("Failed to delete the role");
      }
      setDeleting(null);
    });
  }

  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="roles-tab">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2.5">
        <p className="m-0 min-w-0 flex-[1_1_420px] text-[13px] text-muted-foreground">
          Each user has one role. Built-in roles cannot be changed; custom roles hold the permissions you choose, optionally limited
          to hosts and certificates that carry one of their tags.
        </p>
        {canEdit && (
          <Button variant="outline" onClick={() => startDraft(null)} data-testid="new-custom-role">
            <Plus />
            Create role
          </Button>
        )}
      </div>

      {!licensed && (
        <Banner tone="info" title={`Custom roles need a ${editionLabel} license.`}>
          Creating, changing and assigning custom roles needs an active {productName} {editionLabel} license or higher. Existing roles
          keep working and can still be deleted or taken away.{" "}
          <Link href="/license" className="text-brand underline-offset-4 hover:underline">Licensing</Link>
        </Banner>
      )}
      {listError && <Banner tone="bad" live onDismiss={() => setListError(null)}>{listError}</Banner>}

      <section aria-label="Roles" className="min-w-0 overflow-hidden rounded-2xl border border-line bg-panel">
        <div className="hidden flex-wrap gap-x-4 gap-y-2 border-b border-line py-2 pl-[50px] pr-[18px] text-xs text-soft md:flex">
          <span className="flex-[1_1_260px]">Role</span>
          <span className="w-[110px] flex-none">Permissions</span>
          <span className="w-[150px] flex-none">Scope</span>
          <span className="w-[70px] flex-none text-right">Users</span>
        </div>
        <ul className="m-0 list-none p-0">
          {rows.map((row) => {
            const expanded = open === row.key;
            const own = row.custom !== null && actor.customRoleId === row.custom.id;
            const count = row.permissions.size;
            return (
              <li key={row.key} className="border-b border-line last:border-b-0" data-testid={row.custom ? `role-${row.custom.id}` : `role-${row.key}`}>
                <button
                  type="button"
                  onClick={() => setOpen(expanded ? null : row.key)}
                  aria-expanded={expanded}
                  className={cn(
                    "flex w-full flex-wrap items-center gap-x-4 gap-y-2 px-[18px] py-3.5 text-left transition-colors hover:bg-panel2",
                    expanded && "bg-panel2"
                  )}
                >
                  <ChevronRight
                    aria-hidden="true"
                    className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", expanded && "rotate-90")}
                  />
                  <span className="flex min-w-0 flex-[1_1_260px] flex-col gap-0.5">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold">{row.name}</span>
                      <span className="rounded bg-raise px-1.5 text-[11px] leading-[18px] text-muted-foreground">{row.kind}</span>
                      {row.adminLevel && (
                        <span className="rounded-full bg-warn-tint px-1.5 text-[11px] leading-[18px] font-semibold text-warn">
                          Administrator-level
                        </span>
                      )}
                    </span>
                    <span className="text-[13px] text-muted-foreground">{row.description}</span>
                  </span>
                  <span className="flex w-[110px] flex-none flex-col gap-1">
                    <span>
                      <span className="num">{count}</span> <span className="text-xs text-soft">of {total}</span>
                    </span>
                    <span aria-hidden="true" className="block h-1 w-[88px] overflow-hidden rounded-sm bg-raise">
                      <span className="block h-1 bg-muted-foreground" style={{ width: `${total ? (count / total) * 100 : 0}%` }} />
                    </span>
                  </span>
                  <span className="flex w-[150px] flex-none flex-wrap gap-1">
                    {row.scopeTags.length > 0
                      ? row.scopeTags.map((tag) => (
                          <span key={tag} className="num rounded bg-raise px-1.5 text-[11px] leading-[18px] text-muted-foreground">
                            {tag}
                          </span>
                        ))
                      : <span className="text-[13px] text-muted-foreground">{row.scopeText}</span>}
                  </span>
                  <span className="num w-[70px] flex-none text-right">{row.userCount}</span>
                </button>
                {expanded && (
                  <div className="flex flex-col gap-3.5 bg-panel px-[18px] pb-[18px] pt-1 md:pl-[50px]">
                    {row.custom && (
                      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(250px,100%),1fr))] gap-2.5">
                        {families.map((family) => {
                          const areas = family.areas.filter((area) => area.permissions.some((permission) => row.permissions.has(permission)));
                          if (areas.length === 0) return null;
                          return (
                            <div key={family.title} className="flex flex-col gap-2 rounded-xl border border-line bg-panel2 px-3.5 py-3">
                              <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-soft">{family.title}</span>
                              <ul className="m-0 flex list-none flex-col gap-2 p-0">
                                {areas.map((area) => (
                                  <li key={area.area} className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
                                    <span className="flex min-w-0 flex-[1_1_120px] flex-col">
                                      <span className="text-[13px]">{area.label}</span>
                                      {area.scopable && row.scopeTags.length > 0 && (
                                        <span className="text-xs text-soft">Only those tagged {row.scopeTags.join(", ")}</span>
                                      )}
                                      {area.permissions.some((permission) => adminLevelPermissions.has(permission) && row.permissions.has(permission)) && (
                                        <span className="text-xs text-warn">Administrator-level</span>
                                      )}
                                    </span>
                                    <span className="flex flex-wrap gap-1">
                                      {area.permissions.map((permission) => {
                                        const action = permission.slice(area.area.length + 1);
                                        const granted = row.permissions.has(permission);
                                        return (
                                          <span
                                            key={permission}
                                            className={cn(
                                              "num inline-flex h-[22px] items-center rounded-md border px-[7px] text-[11px]",
                                              granted ? "border-transparent bg-ok-tint text-ok" : "border-dashed border-line2 text-soft"
                                            )}
                                          >
                                            {action}
                                            <span className="sr-only">{granted ? ", granted" : ", not granted"}</span>
                                          </span>
                                        );
                                      })}
                                    </span>
                                  </li>
                                ))}
                              </ul>
                            </div>
                          );
                        })}
                      </div>
                    )}
                    <p className="m-0 text-[13px] text-muted-foreground">{row.detail}</p>
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line pt-3">
                      <span className="min-w-0 flex-[1_1_280px] text-[13px]">
                        <span className="text-soft">Held by</span> {listHolders(row.holders)}
                      </span>
                      {row.custom && canWrite && !own && (
                        <span className="flex flex-wrap gap-2">
                          {licensed && (
                            <Fragment>
                              <Button variant="secondary" size="sm" onClick={() => startDraft(row.custom)}>
                                Edit role
                              </Button>
                              <Button variant="ghost" size="sm" onClick={() => startDraft(row.custom, true)}>
                                Duplicate
                              </Button>
                            </Fragment>
                          )}
                          <Button variant="danger" size="sm" disabled={pending} onClick={() => setDeleting(row.custom)}>
                            Delete role
                          </Button>
                        </span>
                      )}
                      {row.custom && own && <span className="text-xs text-soft">This is your own role; another administrator changes it.</span>}
                      {!row.custom && <span className="text-xs text-soft">Built-in roles cannot be edited or deleted.</span>}
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      <p className="m-0 text-xs text-soft">
        A role is administrator-level when it can decide who signs in or what the instance is: single sign-on, the MFA policy, LDAP,
        SCIM, the license, access reviews, approval policies, or user management together with settings or approving. Only
        administrators create or assign such roles.
      </p>

      {draft && (
        <RoleEditorDialog initial={draft} catalogue={catalogue} actor={actor} saveRole={saveRole} onClose={() => setDraft(null)} />
      )}

      <Dialog open={deleting !== null} onOpenChange={(next) => !next && setDeleting(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Delete the role {deleting?.name}?</DialogTitle>
            <DialogDescription>
              {deleting?.userCount === 1 ? "1 user" : `${deleting?.userCount ?? 0} users`} with it fall back to the Viewer role.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleting(null)}>Cancel</Button>
            <Button variant="danger" disabled={pending} onClick={() => deleting && remove(deleting)}>Delete role</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
