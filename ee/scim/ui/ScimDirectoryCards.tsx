// SPDX-License-Identifier: Elastic-2.0
"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Pencil, Plus, ShieldCheck, Trash2, UserMinus, Users } from "lucide-react";
import { Banner } from "@/components/ui/Banner";
import { EmptyState } from "@/components/ui/EmptyState";
import { SectionCard } from "@/components/ui/SectionCard";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Pagination, useUrlPage } from "@/components/ui/Pagination";
import { SearchField } from "@/components/ui/SearchField";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AppDialog } from "@/components/ui/AppDialog";
import { DEFAULT_PAGE_SIZE, paginate } from "@/src/lib/pagination";
import type { ScimManagedGroupView, ScimManagedUserView, ScimRoleMappingView } from "../types";
import type { ScimClientProps } from "./ScimClient";
import { callApi, Field, formatDate, LOCKED_HINT } from "./shared";

function roleLabel(mapping: Pick<ScimRoleMappingView, "role" | "customRoleId" | "customRoleName">): string {
  if (mapping.customRoleId !== null) return mapping.customRoleName ?? `Custom role ${mapping.customRoleId}`;
  return mapping.role === "admin" ? "Admin" : mapping.role === "user" ? "User" : "Viewer";
}

function MappingsCard(props: ScimClientProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [editing, setEditing] = useState<ScimRoleMappingView | null>(null);
  const [open, setOpen] = useState(false);
  const [groupId, setGroupId] = useState("");
  const [role, setRole] = useState("user");
  const [priority, setPriority] = useState("100");
  const [error, setError] = useState<string | null>(null);
  const configurable = props.settings.configurable;

  function openForm(mapping: ScimRoleMappingView | null) {
    setEditing(mapping);
    setGroupId(mapping ? String(mapping.groupId) : String(props.managedGroups[0]?.groupId ?? ""));
    setRole(mapping ? (mapping.customRoleId !== null ? `custom:${mapping.customRoleId}` : mapping.role) : "user");
    setPriority(mapping ? String(mapping.priority) : "100");
    setError(null);
    setOpen(true);
  }

  function save() {
    const body: Record<string, unknown> = {
      groupId: Number(groupId),
      priority: Number(priority),
      ...(role.startsWith("custom:") ? { customRoleId: Number(role.slice(7)) } : { role, customRoleId: null }),
    };
    startTransition(async () => {
      try {
        await callApi(editing ? `/api/v1/scim/role-mappings/${editing.id}` : "/api/v1/scim/role-mappings", editing ? "PUT" : "POST", body);
        toast.success(editing ? "Mapping updated" : "Mapping added");
        setOpen(false);
        router.refresh();
      } catch (err) {
        setError((err as Error).message);
      }
    });
  }

  function remove(mapping: ScimRoleMappingView) {
    startTransition(async () => {
      try {
        await callApi(`/api/v1/scim/role-mappings/${mapping.id}`, "DELETE");
        toast.success("Mapping deleted");
      } catch (err) {
        toast.error((err as Error).message);
      }
      router.refresh();
    });
  }

  return (
    <SectionCard
      title="Group-to-role mappings"
      count={props.mappings.length}
      actions={props.canWrite ? (
        <Button size="sm" variant="outline" onClick={() => openForm(null)} disabled={!configurable || props.managedGroups.length === 0} title={configurable ? undefined : LOCKED_HINT}>
          <Plus /> Add mapping
        </Button>
      ) : undefined}
    >
        {!props.settings.manageRoles && props.mappings.length > 0 && (
          <div className="px-[18px] pt-3">
            <Banner tone="warn">Manage roles is off, so these mappings are not applied.</Banner>
          </div>
        )}
        {props.mappings.length === 0 ? (
          <EmptyState
            compact
            icon={ShieldCheck}
            title="No mappings"
            description={props.managedGroups.length === 0 ? "Groups appear here once the identity provider pushes them or you hand a group to SCIM." : "Map a SCIM group to a role."}
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Priority</TableHead>
                <TableHead>SCIM group</TableHead>
                <TableHead>Role</TableHead>
                {props.canWrite && <TableHead className="text-right">Actions</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {props.mappings.map((mapping) => (
                <TableRow key={mapping.id}>
                  <TableCell className="num">{mapping.priority}</TableCell>
                  <TableCell className="font-medium">{mapping.groupName}</TableCell>
                  <TableCell>
                    <Badge variant={mapping.role === "admin" && mapping.customRoleId === null ? "info" : "outline"}>{roleLabel(mapping)}</Badge>
                  </TableCell>
                  {props.canWrite && (
                    <TableCell className="text-right whitespace-nowrap">
                      <Button variant="ghost" size="icon-sm" title={configurable ? "Edit" : LOCKED_HINT} aria-label={`Edit the mapping of ${mapping.groupName}`} disabled={!configurable || pending} onClick={() => openForm(mapping)}>
                        <Pencil />
                      </Button>
                      <Button variant="ghost" size="icon-sm" className="text-bad hover:text-bad" title="Delete" aria-label={`Delete the mapping of ${mapping.groupName}`} disabled={pending} onClick={() => remove(mapping)}>
                        <Trash2 />
                      </Button>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}

      <AppDialog open={open} onClose={() => setOpen(false)} title={editing ? "Edit mapping" : "Add mapping"} submitLabel="Save" onSubmit={save} isSubmitting={pending} maxWidth="md">
        <div className="flex flex-col gap-4">
          {error && <Banner tone="bad" live>{error}</Banner>}
          <Field label="SCIM group" htmlFor="mapping-group">
            <Select value={groupId} onValueChange={setGroupId}>
              <SelectTrigger id="mapping-group"><SelectValue placeholder="Choose a group" /></SelectTrigger>
              <SelectContent>
                {props.managedGroups.map((group) => (
                  <SelectItem key={group.groupId} value={String(group.groupId)}>{group.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Role" htmlFor="mapping-role" hint="Only administrators can map the admin role or an administrator-level custom role.">
            <Select value={role} onValueChange={setRole}>
              <SelectTrigger id="mapping-role"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="admin" disabled={!props.isAdmin}>Admin</SelectItem>
                <SelectItem value="user">User</SelectItem>
                <SelectItem value="viewer">Viewer</SelectItem>
                {props.customRoles.map((custom) => (
                  <SelectItem
                    key={custom.id}
                    value={`custom:${custom.id}`}
                    disabled={!props.customRolesLicensed || (custom.adminLevel && !props.isAdmin)}
                  >
                    {custom.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Priority" htmlFor="mapping-priority" hint="Lower numbers win when a user is in several mapped groups.">
            <Input id="mapping-priority" inputMode="numeric" value={priority} onChange={(event) => setPriority(event.target.value)} />
          </Field>
        </div>
      </AppDialog>
    </SectionCard>
  );
}

function statusBadge(user: ScimManagedUserView) {
  if (user.deletedAt) return <Badge variant="muted">Deleted at IdP</Badge>;
  return user.status === "active" ? <Badge variant="success">Active</Badge> : <Badge variant="warning">{user.status}</Badge>;
}

function UsersCard(props: ScimClientProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [userId, setUserId] = useState("");
  const [userName, setUserName] = useState("");
  const [externalId, setExternalId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [releasing, setReleasing] = useState<ScimManagedUserView | null>(null);
  const [query, setQuery] = useState("");
  const { page, hrefFor } = useUrlPage("usersPage");
  const configurable = props.settings.configurable;
  const needle = query.trim().toLowerCase();
  const shown = needle
    ? props.managedUsers.filter((user) => `${user.name ?? ""} ${user.email} ${user.userName}`.toLowerCase().includes(needle))
    : props.managedUsers;
  const slice = paginate(shown, page);

  function search(value: string) {
    setQuery(value);
    if (page > 1) window.history.replaceState(null, "", hrefFor(1));
  }

  function adopt() {
    setError(null);
    startTransition(async () => {
      try {
        await callApi("/api/v1/scim/users", "POST", { userId: Number(userId), userName, externalId: externalId || null });
        toast.success("SCIM now manages this user");
        setOpen(false);
        router.refresh();
      } catch (err) {
        setError((err as Error).message);
      }
    });
  }

  function release() {
    const user = releasing;
    if (!user) return;
    startTransition(async () => {
      try {
        await callApi(`/api/v1/scim/users/${user.userId}`, "DELETE");
        toast.success("SCIM no longer manages this user");
      } catch (err) {
        toast.error((err as Error).message);
      }
      setReleasing(null);
      router.refresh();
    });
  }

  return (
    <SectionCard
      title="SCIM users"
      count={props.managedUsers.length}
      actions={props.canWrite ? (
        <Button size="sm" variant="outline" onClick={() => { setError(null); setUserId(String(props.userOptions[0]?.id ?? "")); setOpen(true); }} disabled={!configurable || props.userOptions.length === 0} title={configurable ? undefined : LOCKED_HINT}>
          <Plus /> Hand over an account
        </Button>
      ) : undefined}
    >
        <p className="m-0 border-b border-line px-[18px] py-3 text-[13px] text-muted-foreground">
          The identity provider cannot create an account that already exists until you hand it over here.
        </p>
        {props.managedUsers.length === 0 ? (
          <EmptyState compact icon={Users} title="No SCIM users yet" description="They appear when the identity provider sends them." />
        ) : (
          <>
            {props.managedUsers.length > DEFAULT_PAGE_SIZE && (
              <div className="border-b border-line px-[18px] py-3">
                <SearchField
                  aria-label="Search SCIM users"
                  placeholder="Name, e-mail or userName"
                  value={query}
                  onChange={(event) => search(event.target.value)}
                  className="w-full max-w-sm"
                />
              </div>
            )}
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Account</TableHead>
                  <TableHead>userName</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>First sign-in linked</TableHead>
                  {props.canWrite && <TableHead className="text-right">Release</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {slice.items.map((user) => (
                  <TableRow key={user.userId}>
                    <TableCell>
                      <div className="font-medium">{user.name ?? user.email}</div>
                      <div className="text-xs text-muted-foreground">{user.email}{user.origin === "adopted" ? " · handed over" : ""}</div>
                    </TableCell>
                    <TableCell className="num text-xs">{user.userName}</TableCell>
                    <TableCell>{statusBadge(user)}</TableCell>
                    <TableCell>{user.customRoleId !== null ? `Custom role ${user.customRoleId}` : user.role}</TableCell>
                    <TableCell>{user.linkedAt ? formatDate(user.linkedAt) : "Not yet"}</TableCell>
                    {props.canWrite && (
                      <TableCell className="text-right">
                        <Button variant="ghost" size="icon-sm" title="Stop SCIM managing this account" aria-label={`Release ${user.email}`} onClick={() => setReleasing(user)} disabled={pending}>
                          <UserMinus />
                        </Button>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {shown.length === 0 && <p className="m-0 border-t border-line px-[18px] py-4 text-[13px] text-muted-foreground">No SCIM user matches.</p>}
            <Pagination
              page={slice.page}
              perPage={slice.perPage}
              total={slice.total}
              noun="users"
              label="Pages of SCIM users"
              hrefFor={hrefFor}
              className="border-t border-line px-[18px] py-3"
            />
          </>
        )}

      <AppDialog open={open} onClose={() => setOpen(false)} title="Hand an account to SCIM" submitLabel="Hand over" onSubmit={adopt} isSubmitting={pending} maxWidth="md">
        <div className="flex flex-col gap-4">
          {error && <Banner tone="bad" live>{error}</Banner>}
          <Banner tone="info">
            The identity provider will be able to change and disable this account, and its first sign-in through the SCIM sign-in
            provider will be linked to it. The primary admin and break-glass accounts cannot be handed over.
          </Banner>
          <Field label="Account" htmlFor="adopt-user">
            <Select value={userId} onValueChange={setUserId}>
              <SelectTrigger id="adopt-user"><SelectValue placeholder="Choose an account" /></SelectTrigger>
              <SelectContent>
                {props.userOptions.map((user) => (
                  <SelectItem key={user.id} value={String(user.id)}>{user.name ? `${user.name} (${user.email})` : user.email}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="userName" htmlFor="adopt-username" hint="Exactly what the identity provider sends as userName (often the user principal name).">
            <Input id="adopt-username" value={userName} maxLength={256} onChange={(event) => setUserName(event.target.value)} />
          </Field>
          <Field label="externalId (optional)" htmlFor="adopt-external-id">
            <Input id="adopt-external-id" value={externalId} maxLength={256} onChange={(event) => setExternalId(event.target.value)} />
          </Field>
        </div>
      </AppDialog>

      <AppDialog open={releasing !== null} onClose={() => setReleasing(null)} title="Stop SCIM managing this account?" submitLabel="Release" onSubmit={release} isSubmitting={pending}>
        <p className="text-sm text-muted-foreground">
          The account stays as it is, but the identity provider can no longer see or change it. If the provider then creates the same
          user again, it is refused because the e-mail address is taken.
        </p>
      </AppDialog>
    </SectionCard>
  );
}

function GroupsCard(props: ScimClientProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [groupId, setGroupId] = useState("");
  const [externalId, setExternalId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const { page, hrefFor } = useUrlPage("groupsPage");
  const configurable = props.settings.configurable;
  const slice = paginate(props.managedGroups, page);

  function adopt() {
    setError(null);
    startTransition(async () => {
      try {
        await callApi("/api/v1/scim/groups", "POST", { groupId: Number(groupId), externalId: externalId || null });
        toast.success("SCIM now manages this group");
        setOpen(false);
        router.refresh();
      } catch (err) {
        setError((err as Error).message);
      }
    });
  }

  function release(group: ScimManagedGroupView) {
    startTransition(async () => {
      try {
        await callApi(`/api/v1/scim/groups/${group.groupId}`, "DELETE");
        toast.success("SCIM no longer manages this group");
      } catch (err) {
        toast.error((err as Error).message);
      }
      router.refresh();
    });
  }

  return (
    <SectionCard
      title="SCIM groups"
      count={props.managedGroups.length}
      actions={props.canWrite ? (
        <Button size="sm" variant="outline" onClick={() => { setError(null); setGroupId(String(props.groupOptions[0]?.id ?? "")); setOpen(true); }} disabled={!configurable || props.groupOptions.length === 0} title={configurable ? undefined : LOCKED_HINT}>
          <Plus /> Hand over a group
        </Button>
      ) : undefined}
    >
        <p className="m-0 border-b border-line px-[18px] py-3 text-[13px] text-muted-foreground">
          In a group you hand over, members SCIM did not add stay.
        </p>
        {props.managedGroups.length === 0 ? (
          <EmptyState compact icon={Users} title="No SCIM groups yet" description="They appear when the identity provider pushes them." />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Group</TableHead>
                <TableHead>Members (SCIM / all)</TableHead>
                <TableHead>Origin</TableHead>
                {props.canWrite && <TableHead className="text-right">Release</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {slice.items.map((group) => (
                <TableRow key={group.groupId}>
                  <TableCell className="font-medium">{group.name}</TableCell>
                  <TableCell className="num">{group.scimMemberCount} / {group.memberCount}</TableCell>
                  <TableCell>{group.origin === "adopted" ? "Handed over" : "Created by SCIM"}</TableCell>
                  {props.canWrite && (
                    <TableCell className="text-right">
                      <Button variant="ghost" size="icon-sm" title="Stop SCIM managing this group" aria-label={`Release ${group.name}`} onClick={() => release(group)} disabled={pending}>
                        <UserMinus />
                      </Button>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        <Pagination
          page={slice.page}
          perPage={slice.perPage}
          total={slice.total}
          noun="groups"
          label="Pages of SCIM groups"
          hrefFor={hrefFor}
          className="border-t border-line px-[18px] py-3"
        />

      <AppDialog open={open} onClose={() => setOpen(false)} title="Hand a group to SCIM" submitLabel="Hand over" onSubmit={adopt} isSubmitting={pending} maxWidth="md">
        <div className="flex flex-col gap-4">
          {error && <Banner tone="bad" live>{error}</Banner>}
          <Field label="Group" htmlFor="adopt-group">
            <Select value={groupId} onValueChange={setGroupId}>
              <SelectTrigger id="adopt-group"><SelectValue placeholder="Choose a group" /></SelectTrigger>
              <SelectContent>
                {props.groupOptions.map((group) => (
                  <SelectItem key={group.id} value={String(group.id)}>{group.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="externalId (optional)" htmlFor="adopt-group-external-id">
            <Input id="adopt-group-external-id" value={externalId} maxLength={256} onChange={(event) => setExternalId(event.target.value)} />
          </Field>
        </div>
      </AppDialog>
    </SectionCard>
  );
}

export default function ScimDirectoryCards(props: ScimClientProps) {
  return (
    <>
      <MappingsCard {...props} />
      <div className="grid gap-5 xl:grid-cols-2">
        <UsersCard {...props} />
        <GroupsCard {...props} />
      </div>
    </>
  );
}
