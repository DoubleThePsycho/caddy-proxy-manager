"use client";

import { useState } from "react";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { UserOverviewEntry } from "@/src/lib/users-overview";
import { deleteUserAction, updateUserStatusAction } from "./actions";
import { resetUserMfaAction } from "./mfa-actions";
import { runUserAction } from "./run-user-action";
import { displayName } from "./user-format";

/** A change to a user that asks for confirmation first. */
export type UserCommand =
  | { kind: "disable"; user: UserOverviewEntry }
  | { kind: "delete"; user: UserOverviewEntry }
  | { kind: "reset-mfa"; user: UserOverviewEntry }
  | { kind: "sign-out"; user: UserOverviewEntry; self: boolean };

type Result = { tone: "ok" | "bad"; text: string };

function describe(command: UserCommand): { title: string; body: string; label: string; danger: boolean } {
  const name = displayName(command.user);
  switch (command.kind) {
    case "disable":
      return {
        title: `Disable ${name}?`,
        body: "Their dashboard and forward-auth sessions end now, and they cannot sign in or use their API tokens until you enable the account again.",
        label: "Disable user",
        danger: true,
      };
    case "delete":
      return {
        title: `Delete ${name}?`,
        body: "The account, its sign-in methods, sessions, API tokens and group memberships are deleted. This cannot be undone; the audit log keeps what they did.",
        label: "Delete user",
        danger: true,
      };
    case "reset-mfa":
      return {
        title: `Reset multi-factor authentication of ${name}?`,
        body: "This removes their authenticator app, backup codes and passkeys. They sign in with their password alone until they set it up again, or the MFA policy makes them. Their sessions are kept.",
        label: "Reset MFA",
        danger: true,
      };
    case "sign-out":
      return {
        title: command.self ? "Sign out your other sessions?" : `Sign out every session of ${name}?`,
        body: command.self
          ? "Every browser signed in to your account except this one has to sign in again."
          : "Every browser signed in to the account has to sign in again. Their API tokens keep working.",
        label: command.self ? "Sign out other sessions" : "Sign out everywhere",
        danger: false,
      };
  }
}

async function signOutEverywhere(userId: number): Promise<{ ok: true; revoked: number } | { ok: false; error: string }> {
  try {
    const response = await fetch(`/api/v1/users/${userId}/sessions`, { method: "DELETE", credentials: "same-origin" });
    const body = (await response.json().catch(() => null)) as { revoked?: number; error?: string } | null;
    if (!response.ok) return { ok: false, error: body?.error ?? "Could not sign the sessions out" };
    return { ok: true, revoked: body?.revoked ?? 0 };
  } catch {
    return { ok: false, error: "Could not sign the sessions out" };
  }
}

/** Confirms and runs a disable, delete, MFA reset or sign-out of a user. */
export default function UserCommandDialog({
  command,
  onClose,
  onDone,
}: {
  command: UserCommand | null;
  onClose: () => void;
  onDone: (result: Result) => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const text = command ? describe(command) : null;

  const run = async () => {
    if (!command) return;
    setPending(true);
    setError(null);
    const name = displayName(command.user);
    let failure: string | null = null;
    let success = "";
    switch (command.kind) {
      case "disable":
        failure = await runUserAction(() => updateUserStatusAction(command.user.id, "disabled"), "Failed to disable user");
        success = `${name} is disabled.`;
        break;
      case "delete":
        failure = await runUserAction(() => deleteUserAction(command.user.id), "Failed to delete user");
        success = `${name} was deleted.`;
        break;
      case "reset-mfa":
        failure = await runUserAction(() => resetUserMfaAction(command.user.id), "Failed to reset MFA");
        success = `Multi-factor authentication of ${name} was reset.`;
        break;
      case "sign-out": {
        const result = await signOutEverywhere(command.user.id);
        if (!result.ok) failure = result.error;
        else success = result.revoked === 1 ? "Signed out 1 session." : `Signed out ${result.revoked} sessions.`;
        break;
      }
    }
    setPending(false);
    if (failure) {
      setError(failure);
      return;
    }
    onDone({ tone: "ok", text: success });
  };

  return (
    <Dialog
      open={command !== null}
      onOpenChange={(next) => {
        if (!next) {
          setError(null);
          onClose();
        }
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{text?.title}</DialogTitle>
          <DialogDescription>{text?.body}</DialogDescription>
        </DialogHeader>
        {error && <Banner tone="bad" live>{error}</Banner>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button variant={text?.danger ? "danger" : "default"} onClick={run} disabled={pending}>
            {pending ? "Working…" : text?.label}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
