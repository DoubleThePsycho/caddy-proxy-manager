"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { MoreHorizontal, Search, UserRound } from "lucide-react";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Pagination, useUrlPage } from "@/components/ui/Pagination";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useFormat } from "@/src/components/preferences/PreferencesProvider";
import { isUsableSignInUsername } from "@/src/lib/login-username";
import { paginate } from "@/src/lib/pagination";
import type { UserOverviewEntry } from "@/src/lib/users-overview";
import { cn } from "@/lib/utils";
import { MfaPolicyPanel, type MfaPolicySummary } from "./MfaPolicyCard";
import type { RoleOptionsProps } from "./RolePicker";
import UserDetailSheet from "./UserDetailSheet";
import UserCommandDialog, { type UserCommand } from "./UserCommandDialog";
import {
  SOURCE_LABELS,
  displayName,
  roleSummary,
  searchText,
  secondFactorSummary,
  signInMethodLabel,
  sourceDetail,
} from "./user-format";
import { runUserAction } from "./run-user-action";
import { Avatar, FactorCell, Tag, UserStatus } from "./user-cells";
import { updateUserStatusAction } from "./actions";

type Filter = "all" | "admins" | "custom" | "inactive";

type Props = {
  users: UserOverviewEntry[];
  currentUserId: number;
  selectedUserId: number | null;
  mfaPolicy: MfaPolicySummary | null;
  canWrite: boolean;
  canWriteMfaPolicy: boolean;
  roleOptions: RoleOptionsProps;
  totalPermissions: number;
  onAddUser?: () => void;
};

const FILTERS: Record<Filter, (user: UserOverviewEntry) => boolean> = {
  all: () => true,
  admins: (user) => user.administrator,
  custom: (user) => user.customRoleId !== null,
  inactive: (user) => user.status !== "active" || user.invited,
};

/** The Users tab: accounts with their role, source, second factor, last sign-in and status. */
export default function UsersTab({
  users,
  currentUserId,
  selectedUserId,
  mfaPolicy,
  canWrite,
  canWriteMfaPolicy,
  roleOptions,
  totalPermissions,
  onAddUser,
}: Props) {
  const router = useRouter();
  const format = useFormat();
  const { page, hrefFor } = useUrlPage();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [openId, setOpenId] = useState<number | null>(
    selectedUserId !== null && users.some((user) => user.id === selectedUserId) ? selectedUserId : null
  );
  const [editOnOpen, setEditOnOpen] = useState(false);
  const [command, setCommand] = useState<UserCommand | null>(null);
  const [notice, setNotice] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);

  const customRoles = useMemo(() => new Map(roleOptions.customRoles.map((role) => [role.id, role])), [roleOptions.customRoles]);
  // Newest accounts first, so one just added is on the first page.
  const rows = useMemo(
    () =>
      [...users].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id).map((user) => {
        const role = roleSummary(user, customRoles, totalPermissions);
        return { user, role, text: searchText(user, role) };
      }),
    [users, customRoles, totalPermissions]
  );
  const needle = query.trim().toLowerCase();
  const shown = rows.filter((row) => FILTERS[filter](row.user) && (!needle || row.text.includes(needle)));
  const slice = paginate(shown, page);
  const counts = Object.fromEntries(
    (Object.keys(FILTERS) as Filter[]).map((key) => [key, users.filter(FILTERS[key]).length])
  ) as Record<Filter, number>;
  const open = users.find((user) => user.id === openId) ?? null;

  const exposedAdmins = users.filter(
    (user) => user.administrator && user.status === "active" && user.secondFactor.state === "none"
  );

  /** A new search or filter starts again at the first page. */
  const firstPage = () => {
    if (page > 1) window.history.replaceState(null, "", hrefFor(1));
  };
  const search = (value: string) => {
    setQuery(value);
    firstPage();
  };
  const show = (value: Filter) => {
    setFilter(value);
    firstPage();
  };

  const openUser = (id: number, edit = false) => {
    setEditOnOpen(edit);
    setOpenId(id);
  };

  const enable = async (user: UserOverviewEntry) => {
    const error = await runUserAction(() => updateUserStatusAction(user.id, "active"), "Failed to enable user");
    setNotice(error ? { tone: "bad", text: error } : { tone: "ok", text: `${displayName(user)} can sign in again.` });
    router.refresh();
  };

  const menu = (user: UserOverviewEntry) => {
    const self = user.id === currentUserId;
    const name = displayName(user);
    const hasFactor = user.secondFactor.state === "authenticator_app" || user.secondFactor.state === "passkey";
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={`More actions for ${name}`}>
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => openUser(user.id)}>Open details</DropdownMenuItem>
          {canWrite && <DropdownMenuItem onSelect={() => openUser(user.id, true)}>Edit user</DropdownMenuItem>}
          {canWrite && (
            <>
              <DropdownMenuSeparator />
              {hasFactor && !self && (
                <DropdownMenuItem onSelect={() => setCommand({ kind: "reset-mfa", user })}>Reset MFA</DropdownMenuItem>
              )}
              <DropdownMenuItem onSelect={() => setCommand({ kind: "sign-out", user, self })}>Sign out everywhere</DropdownMenuItem>
              {!self &&
                (user.status === "active" ? (
                  <DropdownMenuItem onSelect={() => setCommand({ kind: "disable", user })}>Disable user</DropdownMenuItem>
                ) : (
                  <DropdownMenuItem onSelect={() => void enable(user)}>Enable user</DropdownMenuItem>
                ))}
              {!self && (
                <DropdownMenuItem className="text-bad focus:text-bad" onSelect={() => setCommand({ kind: "delete", user })}>
                  Delete user
                </DropdownMenuItem>
              )}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  };

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {notice && (
        <Banner tone={notice.tone} live onDismiss={() => setNotice(null)}>
          {notice.text}
        </Banner>
      )}

      {exposedAdmins.length === 1 && (
        <ExposedAdminBanner
          user={exposedAdmins[0]}
          self={exposedAdmins[0].id === currentUserId}
          canWrite={canWrite}
          date={format.date}
          onOpen={() => openUser(exposedAdmins[0].id)}
          onDisable={() => setCommand({ kind: "disable", user: exposedAdmins[0] })}
        />
      )}
      {exposedAdmins.length > 1 && (
        <Banner
          tone="warn"
          title={`${exposedAdmins.length} administrators have no second factor.`}
          actions={
            <Button variant="outline" size="sm" onClick={() => show("admins")}>
              Show administrators
            </Button>
          }
        >
          They can sign in with a password alone: {exposedAdmins.slice(0, 3).map(displayName).join(", ")}
          {exposedAdmins.length > 3 ? ` and ${exposedAdmins.length - 3} more` : ""}.
        </Banner>
      )}

      {mfaPolicy && <MfaPolicyPanel policy={mfaPolicy} canEdit={canWriteMfaPolicy} />}

      <div className="flex flex-wrap items-center gap-2.5">
        <label className="flex h-[38px] min-w-0 flex-[1_1_260px] items-center gap-2 rounded-[10px] border border-line bg-panel px-3 text-soft focus-within:border-brand">
          <Search aria-hidden="true" className="h-4 w-4 shrink-0" />
          <span className="sr-only">Search users</span>
          <input
            type="search"
            value={query}
            onChange={(event) => search(event.target.value)}
            placeholder="Name, e-mail, role or source"
            className="h-full min-w-0 flex-1 border-0 bg-transparent text-sm text-foreground outline-none placeholder:text-soft"
          />
        </label>
        <SegmentedControl<Filter>
          label="Show"
          value={filter}
          onChange={show}
          options={[
            { value: "all", label: <>All <span className="num text-muted-foreground">{counts.all}</span></> },
            { value: "admins", label: <>Administrators <span className="num text-muted-foreground">{counts.admins}</span></> },
            { value: "custom", label: <>Custom roles <span className="num text-muted-foreground">{counts.custom}</span></> },
            { value: "inactive", label: <>Invited or disabled <span className="num text-muted-foreground">{counts.inactive}</span></> },
          ]}
        />
      </div>

      <section aria-label="Users" className="min-w-0 overflow-hidden rounded-2xl border border-line bg-panel">
        {users.length === 0 ? (
          <EmptyState
            icon={UserRound}
            title="No users yet"
            action={onAddUser ? <Button onClick={onAddUser}>Add user</Button> : undefined}
          />
        ) : (
          <>
            <Table className="min-w-[1100px]">
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">User</TableHead>
                  <TableHead scope="col">Role</TableHead>
                  <TableHead scope="col">Comes from</TableHead>
                  <TableHead scope="col">Second factor</TableHead>
                  <TableHead scope="col">Last sign-in</TableHead>
                  <TableHead scope="col">Status</TableHead>
                  <TableHead scope="col"><span className="sr-only">Actions</span></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {slice.items.map(({ user, role }) => {
                  const name = displayName(user);
                  const self = user.id === currentUserId;
                  const factor = secondFactorSummary(user, format.date);
                  const method = signInMethodLabel(user.lastSignInMethod);
                  const usernameShown = isUsableSignInUsername(user.username) && user.username !== user.email.toLowerCase();
                  return (
                    <TableRow key={user.id} className={cn(user.status !== "active" && "opacity-70")} data-testid={`user-row-${user.id}`}>
                      <TableCell className="py-3">
                        <span className="flex min-w-0 items-center gap-2.5">
                          <Avatar name={name} />
                          <span className="flex min-w-0 flex-col gap-0.5">
                            <span className="flex flex-wrap items-center gap-1.5">
                              <button
                                type="button"
                                onClick={() => openUser(user.id)}
                                className="text-left font-semibold text-foreground underline-offset-4 hover:underline"
                              >
                                {name}
                              </button>
                              {self && <Tag>You</Tag>}
                              {user.primaryAdmin && <Tag>Primary admin</Tag>}
                              {user.breakGlass && <Tag>Break-glass</Tag>}
                            </span>
                            <span className="truncate text-xs text-soft">
                              {user.email}
                              {usernameShown && <> · <span className="num">{user.username}</span></>}
                              {!isUsableSignInUsername(user.username) && user.passwordSignIn && (
                                <span className="text-warn" title="The login page cannot sign this user in with a password until a username is set">
                                  {" "}· no sign-in username
                                </span>
                              )}
                            </span>
                          </span>
                        </span>
                      </TableCell>
                      <TableCell className="py-3">
                        <span className="flex flex-col gap-0.5">
                          <span className="font-medium">{role.label}</span>
                          <span className="text-xs text-soft">{role.detail}</span>
                        </span>
                      </TableCell>
                      <TableCell className="py-3">
                        <span className="flex flex-col gap-1">
                          <span className="flex flex-wrap gap-1">
                            {[...new Set(user.sources.map((source) => source.kind))].map((kind) => (
                              <Tag key={kind} className="num border border-line2">{SOURCE_LABELS[kind]}</Tag>
                            ))}
                            {user.sources.length === 0 && <Tag className="num border border-line2">Local</Tag>}
                          </span>
                          <span className="text-xs text-soft">
                            {user.sources.length === 0 && user.apiTokenLastUsedAt ? "No password, API tokens only" : sourceDetail(user.sources)}
                          </span>
                        </span>
                      </TableCell>
                      <TableCell className="py-3">
                        <FactorCell summary={factor} />
                      </TableCell>
                      <TableCell className="py-3">
                        {user.lastSignInAt ? (
                          <span className="flex flex-col gap-0.5">
                            <span className="num">{format.dateTime(user.lastSignInAt)}</span>
                            {method && <span className="text-xs text-soft">{method}</span>}
                          </span>
                        ) : (
                          <span className="flex flex-col gap-0.5">
                            <span className="text-muted-foreground">Never</span>
                            <span className="text-xs text-soft">
                              {user.apiTokenLastUsedAt
                                ? <>Token used <span className="num">{format.dateTime(user.apiTokenLastUsedAt)}</span></>
                                : user.sources.some((source) => source.kind === "scim")
                                  ? "Linked at first sign-in"
                                  : "Has not signed in yet"}
                            </span>
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="py-3">
                        <UserStatus user={user} />
                      </TableCell>
                      <TableCell className="py-3 text-right">{menu(user)}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            {shown.length === 0 && (
              <div className="flex flex-wrap items-center gap-3 border-t border-line px-[18px] py-5 text-[13px] text-muted-foreground">
                <span>No user matches these filters.</span>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    search("");
                    show("all");
                  }}
                >
                  Clear filters
                </Button>
              </div>
            )}
            <Pagination
              page={slice.page}
              perPage={slice.perPage}
              total={slice.total}
              noun="users"
              label="Pages of users"
              hrefFor={hrefFor}
              className="border-t border-line px-[18px] py-3"
            />
          </>
        )}
      </section>

      <UserDetailSheet
        user={open}
        onClose={() => setOpenId(null)}
        editOnOpen={editOnOpen}
        currentUserId={currentUserId}
        canWrite={canWrite}
        roleOptions={roleOptions}
        totalPermissions={totalPermissions}
        onCommand={setCommand}
        onEnable={(user) => void enable(user)}
      />

      <UserCommandDialog
        command={command}
        onClose={() => setCommand(null)}
        onDone={(result) => {
          setNotice(result);
          if (command?.kind === "delete") setOpenId(null);
          setCommand(null);
          router.refresh();
        }}
      />
    </div>
  );
}

function ExposedAdminBanner({
  user,
  self,
  canWrite,
  date,
  onOpen,
  onDisable,
}: {
  user: UserOverviewEntry;
  self: boolean;
  canWrite: boolean;
  date: (value: string) => string;
  onOpen: () => void;
  onDisable: () => void;
}) {
  const name = displayName(user);
  const directory = user.sources.find((source) => source.kind === "ldap");
  const how = directory ? `${self ? "You sign" : "They sign"} in through ${directory.label} with a password only.` : `${self ? "You sign" : "They sign"} in with a password only.`;
  const factor = user.secondFactor;
  const when =
    factor.gate === "required" && factor.deadline
      ? `The grace period ended on ${date(factor.deadline)}, so the dashboard makes ${self ? "you" : "them"} set up MFA at the next sign-in.`
      : factor.gate === "prompt" && factor.deadline
        ? `${self ? "You are" : "They are"} asked to set it up by ${date(factor.deadline)}.`
        : "The MFA policy does not require it.";
  return (
    <Banner
      tone="warn"
      title={self ? "You are an administrator without a second factor." : `${name} is an administrator without a second factor.`}
      actions={
        self ? (
          <Button asChild variant="outline" size="sm">
            <Link href="/profile">Set up a second factor</Link>
          </Button>
        ) : (
          <>
            <Button variant="outline" size="sm" onClick={onOpen}>
              {canWrite ? "Change role" : "Open details"}
            </Button>
            {canWrite && (
              <Button variant="outline" size="sm" onClick={onDisable}>
                Disable account
              </Button>
            )}
          </>
        )
      }
    >
      {how} {when}
    </Banner>
  );
}
