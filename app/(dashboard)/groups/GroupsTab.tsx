"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { MoreHorizontal, Plus, Search, UserMinus, Users } from "lucide-react";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/EmptyState";
import { Input } from "@/components/ui/input";
import { Pagination, useUrlPage } from "@/components/ui/Pagination";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useFormat } from "@/src/components/preferences/PreferencesProvider";
import { paginate } from "@/src/lib/pagination";
import type { GroupOverviewEntry, GroupRoleMappingSummary, UserOverviewEntry } from "@/src/lib/users-overview";
import {
  addGroupMemberAction,
  createGroupAction,
  deleteGroupAction,
  removeGroupMemberAction,
  updateGroupAction,
  type GroupActionResult,
} from "./actions";

type Props = {
  groups: GroupOverviewEntry[];
  /** Accounts for the member picker; null without users:read. */
  users: UserOverviewEntry[] | null;
  canWrite: boolean;
};

type Member = GroupOverviewEntry["members"][number];

/** Members per page of the members dialog. */
const MEMBERS_PER_PAGE = 10;
/** Users the "add a user" list shows before a search narrows it. */
const USERS_LISTED = 50;

function memberName(member: { name: string | null; email: string }): string {
  return member.name?.trim() || member.email.split("@")[0] || member.email;
}

function mappingRole(mapping: GroupRoleMappingSummary): string {
  if (mapping.customRoleId !== null) return mapping.customRoleName ?? `Custom role ${mapping.customRoleId}`;
  return mapping.role === "admin" ? "Admin" : mapping.role === "user" ? "User" : "Viewer";
}

/** Runs a group Server Action: null when it worked, else the refusal it gave (`fallback` when it failed outright). */
async function attempt(action: () => Promise<GroupActionResult>, fallback: string): Promise<string | null> {
  try {
    const result = await action();
    return result.ok ? null : `${result.error}.`;
  } catch {
    return fallback;
  }
}

/** The text a group search looks in: name, description and members. */
function groupText(group: GroupOverviewEntry): string {
  return [group.name, group.description, ...group.members.flatMap((member) => [member.name, member.email])]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

/** The Groups tab: forward-auth groups, their members, SCIM management, role mappings and the hosts they open. */
export default function GroupsTab({ groups, users, canWrite }: Props) {
  const router = useRouter();
  const format = useFormat();
  const { page, hrefFor } = useUrlPage();
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<GroupOverviewEntry | "new" | null>(null);
  const [membersOf, setMembersOf] = useState<number | null>(null);
  const [deleting, setDeleting] = useState<GroupOverviewEntry | null>(null);
  const [notice, setNotice] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const showRoles = groups.some((group) => group.roleMappings !== null);
  const showHosts = groups.some((group) => group.hosts !== null);
  const openGroup = groups.find((group) => group.id === membersOf) ?? null;
  const needle = query.trim().toLowerCase();
  const shown = needle ? groups.filter((group) => groupText(group).includes(needle)) : groups;
  const slice = paginate(shown, page);

  const search = (value: string) => {
    setQuery(value);
    // A new search starts again at the first page.
    if (page > 1) window.history.replaceState(null, "", hrefFor(1));
  };

  const actions = (group: GroupOverviewEntry) => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={`More actions for group ${group.name}`}>
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => setMembersOf(group.id)}>{canWrite ? "Manage members" : "Members"}</DropdownMenuItem>
        {canWrite && (
          <>
            <DropdownMenuItem onSelect={() => setEditing(group)}>Edit group</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="text-bad focus:text-bad" onSelect={() => setDeleting(group)}>Delete group</DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {groups.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2.5">
          <label className="flex h-[38px] min-w-0 flex-[1_1_260px] items-center gap-2 rounded-[10px] border border-line bg-panel px-3 text-soft focus-within:border-brand">
            <Search aria-hidden="true" className="h-4 w-4 shrink-0" />
            <span className="sr-only">Search groups</span>
            <input
              type="search"
              value={query}
              onChange={(event) => search(event.target.value)}
              placeholder="Group name, description or member"
              className="h-full min-w-0 flex-1 border-0 bg-transparent text-sm text-foreground outline-none placeholder:text-soft"
            />
          </label>
          {canWrite && (
            <Button variant="outline" onClick={() => setEditing("new")}>
              <Plus />
              New group
            </Button>
          )}
        </div>
      )}

      {notice && (
        <Banner tone={notice.tone} live onDismiss={() => setNotice(null)}>
          {notice.text}
        </Banner>
      )}

      <section aria-label="Groups" className="min-w-0 overflow-hidden rounded-2xl border border-line bg-panel">
        {groups.length === 0 ? (
          <EmptyState
            icon={Users}
            title="No groups yet"
            description="Groups decide who gets through the sign-in portal of hosts protected by forward auth."
            action={canWrite ? <Button onClick={() => setEditing("new")}><Plus />New group</Button> : undefined}
          />
        ) : (
          <>
            <Table className="min-w-[980px]">
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">Group</TableHead>
                  <TableHead scope="col">Members</TableHead>
                  <TableHead scope="col">Managed by</TableHead>
                  {showRoles && <TableHead scope="col">Dashboard role</TableHead>}
                  {showHosts && <TableHead scope="col">Lets members reach</TableHead>}
                  <TableHead scope="col"><span className="sr-only">Actions</span></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {slice.items.map((group) => {
                  const names = group.members.map(memberName);
                  return (
                    <TableRow key={group.id} data-testid={`group-row-${group.id}`}>
                      <TableCell className="py-3">
                        <span className="flex flex-col gap-0.5">
                          <button
                            type="button"
                            onClick={() => setMembersOf(group.id)}
                            className="num text-left font-semibold text-foreground underline-offset-4 hover:underline"
                          >
                            {group.name}
                          </button>
                          {group.description && <span className="text-xs text-soft">{group.description}</span>}
                        </span>
                      </TableCell>
                      <TableCell className="py-3">
                        <span className="flex flex-col gap-0.5">
                          <span>
                            <span className="num">{group.members.length}</span> member{group.members.length === 1 ? "" : "s"}
                          </span>
                          {names.length > 0 && (
                            <span className="text-xs text-soft">
                              {names.slice(0, 3).join(", ")}
                              {names.length > 3 ? ` and ${names.length - 3} more` : ""}
                            </span>
                          )}
                        </span>
                      </TableCell>
                      <TableCell className="py-3">
                        {group.scim ? (
                          <span className="flex flex-col gap-0.5">
                            <span>SCIM</span>
                            <span className="text-xs text-soft">
                              {group.scim.origin === "adopted" ? "Handed over" : "Created by SCIM"}, updated{" "}
                              <span className="num">{format.date(group.scim.updatedAt)}</span>
                            </span>
                          </span>
                        ) : (
                          "Local"
                        )}
                      </TableCell>
                      {showRoles && (
                        <TableCell className="py-3">
                          {group.roleMappings && group.roleMappings.length > 0 ? (
                            <span className="flex flex-col gap-0.5">
                              {group.roleMappings.map((mapping) => (
                                <span key={`${mapping.priority}-${mapping.role}-${mapping.customRoleId}`} className="flex flex-col">
                                  <span>{mappingRole(mapping)}</span>
                                  <span className="text-xs text-soft">
                                    Mapping, priority <span className="num">{mapping.priority}</span>
                                  </span>
                                </span>
                              ))}
                            </span>
                          ) : (
                            <span className="text-soft">None</span>
                          )}
                        </TableCell>
                      )}
                      {showHosts && (
                        <TableCell className="py-3">
                          {group.hosts && group.hosts.length > 0 ? (
                            <span className="flex flex-wrap gap-x-2.5 gap-y-1">
                              {group.hosts.slice(0, 4).map((host) => (
                                <span key={host.id} className="num">{host.domain}</span>
                              ))}
                              {group.hosts.length > 4 && <span className="text-soft">and {group.hosts.length - 4} more</span>}
                            </span>
                          ) : (
                            <span className="text-soft">No host yet</span>
                          )}
                        </TableCell>
                      )}
                      <TableCell className="py-3 text-right">{actions(group)}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            {shown.length === 0 && (
              <div className="flex flex-wrap items-center gap-3 border-t border-line px-[18px] py-5 text-[13px] text-muted-foreground">
                <span>No group matches the search.</span>
                <Button variant="secondary" size="sm" onClick={() => search("")}>
                  Clear search
                </Button>
              </div>
            )}
            <Pagination
              page={slice.page}
              perPage={slice.perPage}
              total={slice.total}
              noun="groups"
              label="Pages of groups"
              hrefFor={hrefFor}
              className="border-t border-line px-[18px] py-3"
            />
          </>
        )}
      </section>

      {editing !== null && (
        <GroupFormDialog
          group={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(text) => {
            setEditing(null);
            setNotice({ tone: "ok", text });
            router.refresh();
          }}
        />
      )}

      {openGroup && (
        <MembersDialog
          group={openGroup}
          users={users}
          canWrite={canWrite}
          onClose={() => setMembersOf(null)}
          onChanged={() => router.refresh()}
        />
      )}

      <Dialog open={deleting !== null} onOpenChange={(next) => !next && setDeleting(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Delete group {deleting?.name}?</DialogTitle>
            <DialogDescription>
              Its members lose the access it gives them on hosts protected by forward auth. The users themselves are kept.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleting(null)}>Cancel</Button>
            <Button
              variant="danger"
              onClick={async () => {
                const group = deleting;
                if (!group) return;
                const error = await attempt(() => deleteGroupAction(group.id), "Could not delete the group.");
                setDeleting(null);
                setNotice(error ? { tone: "bad", text: error } : { tone: "ok", text: `Group ${group.name} was deleted.` });
                router.refresh();
              }}
            >
              Delete group
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function GroupFormDialog({
  group,
  onClose,
  onSaved,
}: {
  group: GroupOverviewEntry | null;
  onClose: () => void;
  onSaved: (text: string) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{group ? `Edit group ${group.name}` : "New group"}</DialogTitle>
          <DialogDescription>Hosts let a group in on their forward-auth settings.</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={async (event) => {
            event.preventDefault();
            const formData = new FormData(event.currentTarget);
            setPending(true);
            setError(null);
            const failure = await attempt(
              () => (group ? updateGroupAction(group.id, formData) : createGroupAction(formData)),
              "Could not save the group."
            );
            setPending(false);
            if (failure) {
              setError(failure);
              return;
            }
            onSaved(group ? "Group saved." : `Group ${String(formData.get("name") ?? "")} was created.`);
          }}
        >
          {error && <Banner tone="bad" live>{error}</Banner>}
          <div className="space-y-1.5">
            <Label htmlFor="group-name">Name</Label>
            <Input id="group-name" name="name" defaultValue={group?.name ?? ""} placeholder="e.g. developers" required maxLength={100} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="group-description">Description</Label>
            <Input id="group-description" name="description" defaultValue={group?.description ?? ""} placeholder="Optional" />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={pending}>{pending ? "Saving…" : group ? "Save" : "Create"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function MembersDialog({
  group,
  users,
  canWrite,
  onClose,
  onChanged,
}: {
  group: GroupOverviewEntry;
  users: UserOverviewEntry[] | null;
  canWrite: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [query, setQuery] = useState("");
  const [memberQuery, setMemberQuery] = useState("");
  const [memberPage, setMemberPage] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const memberIds = new Set(group.members.map((member) => member.userId));
  const needle = query.trim().toLowerCase();
  const available = (users ?? [])
    .filter((user) => !memberIds.has(user.id))
    .filter((user) => !needle || `${user.name ?? ""} ${user.email}`.toLowerCase().includes(needle));
  const memberNeedle = memberQuery.trim().toLowerCase();
  const members = memberNeedle
    ? group.members.filter((member) => `${member.name ?? ""} ${member.email}`.toLowerCase().includes(memberNeedle))
    : group.members;
  const memberSlice = paginate(members, memberPage, MEMBERS_PER_PAGE);

  const change = async (run: () => Promise<GroupActionResult>, fallback: string) => {
    setPending(true);
    setError(null);
    const failure = await attempt(run, fallback);
    setPending(false);
    if (failure) setError(failure);
    onChanged();
  };

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Members of {group.name}</DialogTitle>
          <DialogDescription>
            {group.scim
              ? "The identity provider manages this group. People you add here reach its hosts but never get a role from it."
              : `${group.members.length} member${group.members.length === 1 ? "" : "s"}`}
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-col gap-4 overflow-y-auto">
          {error && <Banner tone="bad" live>{error}</Banner>}
          {group.members.length === 0 ? (
            <p className="m-0 text-[13px] text-muted-foreground">No members yet.</p>
          ) : (
            <div className="flex flex-col gap-2">
              {group.members.length > MEMBERS_PER_PAGE && (
                <label className="flex h-9 items-center gap-2 rounded-lg border border-line bg-panel px-3 text-soft focus-within:border-brand">
                  <Search aria-hidden="true" className="h-4 w-4 shrink-0" />
                  <span className="sr-only">Find a member</span>
                  <input
                    type="search"
                    value={memberQuery}
                    onChange={(event) => {
                      setMemberQuery(event.target.value);
                      setMemberPage(1);
                    }}
                    placeholder="Find a member"
                    className="h-full min-w-0 flex-1 border-0 bg-transparent text-sm text-foreground outline-none placeholder:text-soft"
                  />
                </label>
              )}
              {members.length === 0 ? (
                <p className="m-0 text-[13px] text-muted-foreground">No member matches.</p>
              ) : (
                <ul className="m-0 flex list-none flex-col divide-y divide-line rounded-xl border border-line p-0" aria-label="Members">
                  {memberSlice.items.map((member: Member) => (
                    <li key={member.userId} className="flex items-center gap-3 px-3 py-2">
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-[13px] font-medium">{memberName(member)}</span>
                        <span className="truncate text-xs text-soft">{member.email}</span>
                      </span>
                      {canWrite && (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          title="Remove member"
                          aria-label={`Remove ${memberName(member)}`}
                          disabled={pending}
                          onClick={() => change(() => removeGroupMemberAction(group.id, member.userId), "Could not remove the member.")}
                        >
                          <UserMinus />
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              <Pagination
                page={memberSlice.page}
                perPage={memberSlice.perPage}
                total={memberSlice.total}
                noun="members"
                label="Pages of members"
                onPageChange={setMemberPage}
              />
            </div>
          )}
          {canWrite && users !== null && (
            <div className="flex flex-col gap-2">
              <p className="m-0 text-sm font-medium">Add a user to this group</p>
              <label className="flex h-9 items-center gap-2 rounded-lg border border-line bg-panel px-3 text-soft focus-within:border-brand">
                <Search aria-hidden="true" className="h-4 w-4 shrink-0" />
                <span className="sr-only">Find a user</span>
                <input
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Name or e-mail"
                  className="h-full min-w-0 flex-1 border-0 bg-transparent text-sm text-foreground outline-none placeholder:text-soft"
                />
              </label>
              {available.length === 0 ? (
                <p className="m-0 text-[13px] text-muted-foreground">
                  {needle ? "No user matches." : "Every user is already in this group."}
                </p>
              ) : (
                <ul className="m-0 flex max-h-56 list-none flex-col divide-y divide-line overflow-y-auto rounded-xl border border-line p-0" aria-label="Users to add">
                  {available.slice(0, USERS_LISTED).map((user) => (
                    <li key={user.id}>
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() => change(() => addGroupMemberAction(group.id, user.id), "Could not add the member.")}
                        className="flex w-full items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-panel2 disabled:opacity-50"
                      >
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="truncate text-[13px]">{memberName(user)}</span>
                          <span className="truncate text-xs text-soft">{user.email}</span>
                        </span>
                        <span className="text-xs text-brand">Add</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {available.length > USERS_LISTED && (
                <p className="m-0 text-xs text-soft">
                  {USERS_LISTED} of <span className="num">{available.length}</span> shown. Search to find others.
                </p>
              )}
            </div>
          )}
          {canWrite && users === null && (
            <p className="m-0 text-xs text-soft">Adding members needs the users:read permission, to list the users.</p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
