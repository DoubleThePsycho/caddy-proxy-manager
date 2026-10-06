"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Laptop, MonitorSmartphone, Smartphone, Tablet } from "lucide-react";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useFormat } from "@/src/components/preferences/PreferencesProvider";
import type { MfaStatus } from "@/src/lib/mfa";
import type { SessionView } from "@/src/lib/models/sessions";
import type { UserOverviewEntry } from "@/src/lib/users-overview";
import { updateUserInfoAction, updateUserRoleAction } from "./actions";
import { RoleOptions, roleChoice, type RoleOptionsProps } from "./RolePicker";
import { runUserAction } from "./run-user-action";
import type { UserCommand } from "./UserCommandDialog";
import { Avatar, FactorCell, UserStatus } from "./user-cells";
import {
  SOURCE_LABELS,
  displayName,
  roleSummary,
  secondFactorSummary,
  signInMethodLabel,
  sourceDetail,
} from "./user-format";

type Props = {
  user: UserOverviewEntry | null;
  onClose: () => void;
  /** Open the details form right away (Edit user in the row menu). */
  editOnOpen: boolean;
  currentUserId: number;
  canWrite: boolean;
  roleOptions: RoleOptionsProps;
  totalPermissions: number;
  onCommand: (command: UserCommand) => void;
  onEnable: (user: UserOverviewEntry) => void;
};

type Loaded<T> = { state: "loading" } | { state: "error"; message: string } | { state: "ready"; value: T };

async function readJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { credentials: "same-origin", signal });
  const body = (await response.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!response.ok || body === null) throw new Error(body?.error ?? `Request failed (HTTP ${response.status})`);
  return body;
}

function Section({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 border-t border-line px-5 py-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="m-0 text-sm font-semibold">{title}</h3>
        {actions && <div className="ml-auto flex flex-wrap gap-2">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-xs text-soft">{label}</dt>
      <dd className="m-0 min-w-0 text-[13px] break-words">{children}</dd>
    </div>
  );
}

function DeviceIcon({ kind }: { kind: SessionView["device"]["kind"] }) {
  const className = "h-4 w-4 shrink-0 text-muted-foreground";
  if (kind === "mobile") return <Smartphone className={className} aria-hidden="true" />;
  if (kind === "tablet") return <Tablet className={className} aria-hidden="true" />;
  if (kind === "desktop") return <Laptop className={className} aria-hidden="true" />;
  return <MonitorSmartphone className={className} aria-hidden="true" />;
}

/**
 * A user's panel: what the row shows in full, the role, the details the
 * login page uses, their second factors and their dashboard sessions, and
 * the changes an administrator makes to an account.
 */
export default function UserDetailSheet(props: Props) {
  const { user, onClose } = props;
  return (
    <Sheet open={user !== null} onOpenChange={(next) => !next && onClose()}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 overflow-y-auto p-0 sm:max-w-[560px]">
        {user && <SheetBody key={user.id} {...props} user={user} />}
      </SheetContent>
    </Sheet>
  );
}

function SheetBody({
  user,
  editOnOpen,
  currentUserId,
  canWrite,
  roleOptions,
  totalPermissions,
  onCommand,
  onEnable,
}: Props & { user: UserOverviewEntry }) {
  const router = useRouter();
  const format = useFormat();
  const self = user.id === currentUserId;
  const name = displayName(user);
  const customRoles = new Map(roleOptions.customRoles.map((role) => [role.id, role]));
  const role = roleSummary(user, customRoles, totalPermissions);
  const method = signInMethodLabel(user.lastSignInMethod);
  const hasFactor = user.secondFactor.state === "authenticator_app" || user.secondFactor.state === "passkey";

  const initialRole = roleChoice(user);
  const [roleValue, setRoleValue] = useState(initialRole);
  const [roleError, setRoleError] = useState<string | null>(null);
  const [rolePending, setRolePending] = useState(false);

  const [editing, setEditing] = useState(editOnOpen && canWrite);
  const [editError, setEditError] = useState<string | null>(null);
  const [editPending, setEditPending] = useState(false);

  const [mfa, setMfa] = useState<Loaded<MfaStatus>>({ state: "loading" });
  const [sessions, setSessions] = useState<Loaded<SessionView[]>>({ state: "loading" });
  const [sessionNote, setSessionNote] = useState<string | null>(null);
  const [sessionPending, setSessionPending] = useState<number | null>(null);

  const loadSessions = useCallback(async (signal?: AbortSignal) => {
    try {
      setSessions({ state: "ready", value: await readJson<SessionView[]>(`/api/v1/users/${user.id}/sessions`, signal) });
    } catch (error) {
      if (signal?.aborted) return;
      setSessions({ state: "error", message: (error as Error).message });
    }
  }, [user.id]);

  useEffect(() => {
    const controller = new AbortController();
    readJson<MfaStatus>(`/api/v1/users/${user.id}/mfa`, controller.signal)
      .then((value) => setMfa({ state: "ready", value }))
      .catch((error: Error) => {
        if (!controller.signal.aborted) setMfa({ state: "error", message: error.message });
      });
    void loadSessions(controller.signal);
    return () => controller.abort();
  }, [user.id, loadSessions]);

  const saveRole = async () => {
    setRoleError(null);
    setRolePending(true);
    const error = await runUserAction(() => updateUserRoleAction(user.id, roleValue), "Failed to update user role");
    setRolePending(false);
    if (error) setRoleError(error);
    else router.refresh();
  };

  const signOutOne = async (session: SessionView) => {
    setSessionPending(session.id);
    setSessionNote(null);
    try {
      const response = await fetch(`/api/v1/users/${user.id}/sessions/${session.id}`, { method: "DELETE", credentials: "same-origin" });
      setSessionNote(response.ok ? `Signed out ${session.device.label}.` : "Could not sign that session out. Try again.");
    } catch {
      setSessionNote("Could not sign that session out. Try again.");
    }
    setSessionPending(null);
    await loadSessions();
  };

  return (
    <>
      <SheetHeader className="space-y-0 px-5 pb-4 pt-5 pr-14 text-left">
        <div className="flex items-start gap-3">
          <Avatar name={name} className="h-10 w-10 text-sm" />
          <div className="flex min-w-0 flex-col gap-1">
            <SheetTitle className="text-lg leading-7">{name}</SheetTitle>
            <SheetDescription className="truncate text-[13px]">{user.email}</SheetDescription>
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <UserStatus user={user} />
              {self && <span className="rounded bg-raise px-1.5 text-[11px] leading-[18px] text-muted-foreground">You</span>}
              {user.primaryAdmin && <span className="rounded bg-raise px-1.5 text-[11px] leading-[18px] text-muted-foreground">Primary admin</span>}
              {user.breakGlass && <span className="rounded bg-raise px-1.5 text-[11px] leading-[18px] text-muted-foreground">Break-glass</span>}
            </div>
          </div>
        </div>
      </SheetHeader>

      <dl className="m-0 grid grid-cols-[repeat(auto-fit,minmax(min(200px,100%),1fr))] gap-x-5 gap-y-3 border-t border-line px-5 py-4">
        <Fact label="Role">
          <span className="font-medium">{role.label}</span>
          <span className="block text-xs text-soft">{role.detail}</span>
        </Fact>
        <Fact label="Comes from">
          {user.sources.length > 0 ? user.sources.map((source) => `${SOURCE_LABELS[source.kind]} (${source.label})`).join(", ") : "Local"}
          <span className="block text-xs text-soft">{sourceDetail(user.sources)}</span>
        </Fact>
        <Fact label="Second factor">
          <FactorCell summary={secondFactorSummary(user, format.date)} />
        </Fact>
        <Fact label="Last sign-in">
          {user.lastSignInAt ? (
            <>
              <span className="num">{format.dateTime(user.lastSignInAt)}</span>
              {method && <span className="block text-xs text-soft">{method}</span>}
            </>
          ) : (
            "Never"
          )}
        </Fact>
        <Fact label="API tokens">
          {user.apiTokenLastUsedAt ? <>Last used <span className="num">{format.dateTime(user.apiTokenLastUsedAt)}</span></> : "None used"}
        </Fact>
        <Fact label="Created">
          <span className="num">{format.dateTime(user.createdAt)}</span>
        </Fact>
        {user.username && (
          <Fact label="Sign-in username">
            <span className="num">{user.username}</span>
          </Fact>
        )}
      </dl>

      {user.roleManagedBy && (
        <div className="px-5 pb-4">
          <Banner tone="warn" title={`${user.roleManagedBy}.`}>
            A role chosen here is replaced at their next sign-in or the next change from the identity provider. Change it at the source.
          </Banner>
        </div>
      )}

      <Section title="Role">
        {self ? (
          <p className="m-0 text-[13px] text-muted-foreground">You cannot change your own role.</p>
        ) : !canWrite ? (
          <p className="m-0 text-[13px] text-muted-foreground">Changing roles needs the users:write permission.</p>
        ) : (
          <div className="flex flex-col gap-2">
            {roleError && <Banner tone="bad" live>{roleError}</Banner>}
            <div className="flex flex-wrap items-end gap-2">
              <div className="flex min-w-[200px] flex-1 flex-col gap-1.5">
                <Label htmlFor={`role-${user.id}`}>Role</Label>
                <Select value={roleValue} onValueChange={setRoleValue}>
                  <SelectTrigger id={`role-${user.id}`} data-testid={`edit-role-${user.id}`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <RoleOptions {...roleOptions} current={initialRole} />
                  </SelectContent>
                </Select>
              </div>
              <Button onClick={saveRole} disabled={rolePending || roleValue === initialRole}>
                {rolePending ? "Saving…" : "Change role"}
              </Button>
            </div>
          </div>
        )}
      </Section>

      <Section
        title="Details"
        actions={canWrite && !editing ? <Button variant="outline" size="sm" onClick={() => setEditing(true)}>Edit details</Button> : undefined}
      >
        {editing ? (
          <form
            // onSubmit keeps the entered values when the save fails.
            onSubmit={async (event) => {
              event.preventDefault();
              const formData = new FormData(event.currentTarget);
              setEditError(null);
              setEditPending(true);
              // Name, email and username are saved together or not at all.
              const failure = await runUserAction(() => updateUserInfoAction(user.id, formData), "Failed to update user");
              setEditPending(false);
              if (failure) {
                setEditError(failure);
                return;
              }
              setEditing(false);
              router.refresh();
            }}
            className="flex flex-col gap-3"
          >
            {editError && <Banner tone="bad" live>{editError}</Banner>}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor={`name-${user.id}`}>Name</Label>
                <Input id={`name-${user.id}`} name="name" defaultValue={user.name ?? ""} placeholder="Display name" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`email-${user.id}`}>Email</Label>
                <Input id={`email-${user.id}`} name="email" defaultValue={user.email} placeholder="Email address" />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor={`username-${user.id}`}>Username</Label>
                <Input
                  id={`username-${user.id}`}
                  name="username"
                  defaultValue={user.username ?? ""}
                  placeholder="Sign-in username"
                  autoCapitalize="none"
                  autoComplete="off"
                  spellCheck={false}
                  className="num"
                />
                <p className="text-xs text-muted-foreground">Lowercase letters, digits and _ . @ -</p>
              </div>
            </div>
            <div className="flex gap-2">
              <Button type="submit" size="sm" disabled={editPending}>{editPending ? "Saving…" : "Save"}</Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => { setEditing(false); setEditError(null); }}>
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          <dl className="m-0 grid grid-cols-[repeat(auto-fit,minmax(min(200px,100%),1fr))] gap-x-5 gap-y-3">
            <Fact label="Name">{user.name || "Not set"}</Fact>
            <Fact label="Email">{user.email}</Fact>
          </dl>
        )}
      </Section>

      <Section
        title="Multi-factor authentication"
        actions={canWrite && !self && hasFactor ? (
          <Button variant="danger" size="sm" onClick={() => onCommand({ kind: "reset-mfa", user })}>Reset MFA</Button>
        ) : undefined}
      >
        {mfa.state === "loading" && <p className="m-0 text-[13px] text-muted-foreground">Loading…</p>}
        {mfa.state === "error" && <p className="m-0 text-[13px] text-bad">{mfa.message}</p>}
        {mfa.state === "ready" && (
          <dl className="m-0 grid grid-cols-[repeat(auto-fit,minmax(min(160px,100%),1fr))] gap-x-5 gap-y-3">
            <Fact label="Authenticator app">
              {mfa.value.authenticatorApp ? "Set up" : "Not set up"}
              {mfa.value.authenticatorApp && mfa.value.backupCodesRemaining !== null && (
                <span className="block text-xs text-soft">
                  <span className="num">{mfa.value.backupCodesRemaining}</span> backup code{mfa.value.backupCodesRemaining === 1 ? "" : "s"} left
                </span>
              )}
            </Fact>
            <Fact label="Passkeys">
              <span className="num">{mfa.value.passkeys}</span>
            </Fact>
            <Fact label="Policy">
              {!mfa.value.required
                ? "Not required for this account"
                : mfa.value.enabled
                  ? "Required, met"
                  : mfa.value.gate === "required"
                    ? "Required, overdue"
                    : `Required by ${mfa.value.deadline ? format.date(mfa.value.deadline) : "the deadline"}`}
            </Fact>
          </dl>
        )}
        {self && <p className="m-0 text-xs text-soft">You manage your own second factors on <Link href="/profile" className="text-brand underline-offset-4 hover:underline">Profile</Link>.</p>}
      </Section>

      <Section
        title="Sessions"
        actions={canWrite && sessions.state === "ready" && sessions.value.some((session) => !session.current) ? (
          <Button variant="outline" size="sm" onClick={() => onCommand({ kind: "sign-out", user, self })}>
            {self ? "Sign out other sessions" : "Sign out everywhere"}
          </Button>
        ) : undefined}
      >
        {sessionNote && <p role="status" className="m-0 text-[13px] text-muted-foreground">{sessionNote}</p>}
        {sessions.state === "loading" && <p className="m-0 text-[13px] text-muted-foreground">Loading…</p>}
        {sessions.state === "error" && <p className="m-0 text-[13px] text-bad">{sessions.message}</p>}
        {sessions.state === "ready" && sessions.value.length === 0 && (
          <p className="m-0 text-[13px] text-muted-foreground">Not signed in anywhere.</p>
        )}
        {sessions.state === "ready" && sessions.value.length > 0 && (
          <ul className="m-0 flex list-none flex-col divide-y divide-line rounded-xl border border-line p-0">
            {sessions.value.map((session) => (
              <li key={session.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5">
                <DeviceIcon kind={session.device.kind} />
                <span className="flex min-w-0 flex-[1_1_220px] flex-col gap-0.5">
                  <span className="text-[13px] font-medium">
                    {session.device.label}
                    {session.current && <span className="ml-2 text-xs font-normal text-ok">This session</span>}
                  </span>
                  <span className="text-xs text-soft">
                    {session.location?.country ?? "Unknown place"}
                    {session.location?.asn ? ` · AS${session.location.asn}${session.location.network ? ` ${session.location.network}` : ""}` : ""}
                    {" · signed in "}
                    <span className="num">{format.dateTime(session.signedInAt)}</span>
                    {" · last seen "}
                    <span className="num">{format.dateTime(session.lastSeenAt)}</span>
                  </span>
                </span>
                {canWrite && !session.current && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={sessionPending !== null}
                    onClick={() => signOutOne(session)}
                    aria-label={`Sign out ${session.device.label}`}
                  >
                    Sign out
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>

      {canWrite && !self && (
        <Section title="Account">
          <div className="flex flex-wrap gap-2">
            {user.status === "active" ? (
              <Button variant="outline" size="sm" onClick={() => onCommand({ kind: "disable", user })}>Disable user</Button>
            ) : (
              <Button variant="outline" size="sm" onClick={() => onEnable(user)}>Enable user</Button>
            )}
            <Button variant="danger" size="sm" onClick={() => onCommand({ kind: "delete", user })}>Delete user</Button>
          </div>
        </Section>
      )}
    </>
  );
}
