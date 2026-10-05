"use client";

import { FormEvent, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { Info, KeyRound, Plus } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { BackupCodesPanel } from "@/src/components/mfa/BackupCodesPanel";
import { TotpEnrollment } from "@/src/components/mfa/TotpEnrollment";
import { describeMfaError, mfaApi } from "@/src/components/mfa/mfa-api";
import { addPasskey, describePasskeyError, passkeyApi, passkeysSupported } from "@/src/components/passkeys/passkey-api";
import { useFormat } from "@/src/components/preferences/PreferencesProvider";
import type { MfaStatus } from "@/src/lib/mfa";
import type { PasskeyView } from "@/src/lib/passkeys";

type DialogState =
  | { kind: "closed" }
  | { kind: "setup" }
  | { kind: "regenerate"; codes: string[] | null }
  | { kind: "disable" }
  | { kind: "add-passkey" }
  | { kind: "rename-passkey"; passkey: PasskeyView }
  | { kind: "remove-passkey"; passkey: PasskeyView };

const noSubscription = () => () => {};

function Row({ children }: { children: React.ReactNode }) {
  return <li className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-start sm:justify-between">{children}</li>;
}

/**
 * Profile: the password, the authenticator app (TOTP with backup codes) and
 * passkeys. Secrets never reach this component: only flags and counts.
 */
export default function SignInSecurity({
  hasPassword,
  signInProblem,
  oauthOnlyNote,
  passwordRefused,
  ssoEnforced,
  ssoHost,
  mfa,
  passkeys,
  passkeyBlocker,
  onChangePassword,
}: {
  hasPassword: boolean;
  /** Why the login page cannot use the password, or null. */
  signInProblem: string | null;
  /** The account signs in only through an identity provider and has no password. */
  oauthOnlyNote: boolean;
  /** SSO is enforced and this is not a break-glass account. */
  passwordRefused: boolean;
  ssoEnforced: boolean;
  ssoHost: string | null;
  mfa: MfaStatus;
  passkeys: PasskeyView[];
  passkeyBlocker: string | null;
  onChangePassword: () => void;
}) {
  const router = useRouter();
  const format = useFormat();
  const [dialog, setDialog] = useState<DialogState>({ kind: "closed" });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const webAuthn = useSyncExternalStore(noSubscription, passkeysSupported, () => true);

  const close = () => {
    setDialog({ kind: "closed" });
    setError(null);
    setPending(false);
    router.refresh();
  };

  const withPassword = (action: (password: string, form: FormData) => Promise<void>) => async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const password = String(form.get("password") ?? "");
    if (!password) {
      setError("Enter your password.");
      return;
    }
    setError(null);
    setPending(true);
    await action(password, form);
    setPending(false);
  };

  const regenerate = withPassword(async (password) => {
    const result = await mfaApi.generateBackupCodes(password);
    if (!result.ok) {
      setError(describeMfaError(result.error));
      return;
    }
    setDialog({ kind: "regenerate", codes: result.data.backupCodes });
  });

  const disable = withPassword(async (password) => {
    const result = await mfaApi.disable(password);
    if (!result.ok) {
      setError(describeMfaError(result.error));
      return;
    }
    close();
  });

  const createPasskey = withPassword(async (password, form) => {
    const result = await addPasskey(password, String(form.get("name") ?? ""));
    if (!result.ok) {
      setError(describePasskeyError(result.error));
      return;
    }
    setNotice("Passkey added.");
    close();
  });

  const renamePasskey = async (event: FormEvent<HTMLFormElement>, passkey: PasskeyView) => {
    event.preventDefault();
    const name = String(new FormData(event.currentTarget).get("name") ?? "").trim();
    setPending(true);
    const result = await passkeyApi.rename(passkey.id, name);
    setPending(false);
    if (!result.ok) {
      setError(describePasskeyError(result.error));
      return;
    }
    close();
  };

  const removePasskey = async (passkey: PasskeyView) => {
    setPending(true);
    const result = await passkeyApi.remove(passkey.id);
    setPending(false);
    if (!result.ok) {
      setError(describePasskeyError(result.error));
      return;
    }
    close();
  };

  const remaining = mfa.backupCodesRemaining;
  // Removing this would leave a covered account without a second factor.
  const lastRequiredFactor = (kind: "totp" | "passkey") =>
    mfa.required && (kind === "totp" ? mfa.passkeys === 0 : !mfa.authenticatorApp && mfa.passkeys <= 1);
  const ssoNote = ssoEnforced && passwordRefused;

  return (
    <section aria-labelledby="sec-title" className="flex flex-col gap-5 rounded-xl border bg-card p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="sec-title" className="text-base font-semibold">Sign-in security</h2>
        {mfa.enabled ? (
          <Badge variant="success">Multi-factor on</Badge>
        ) : mfa.required ? (
          <Badge variant="warning">Required</Badge>
        ) : (
          <Badge variant="secondary">Multi-factor off</Badge>
        )}
      </div>

      {ssoNote && (
        <div role="note" className="flex items-start gap-2.5 rounded-lg bg-muted/60 px-3 py-2.5 text-[13px] leading-[18px]">
          <Info className="mt-px h-4 w-4 flex-none text-muted-foreground" aria-hidden="true" />
          <span>Single sign-on is enforced: you sign in through {ssoHost ?? "your identity provider"}.</span>
        </div>
      )}

      {notice && (
        <Alert>
          <AlertDescription className="flex items-center justify-between gap-2">
            {notice}
            <Button variant="ghost" size="sm" onClick={() => setNotice(null)} className="h-auto p-0 text-xs">Dismiss</Button>
          </AlertDescription>
        </Alert>
      )}

      {mfa.required && !mfa.enabled && (
        <Alert className="border-warn/30 bg-warn-tint text-foreground">
          <AlertDescription>
            Your administrator requires multi-factor authentication for your account
            {mfa.deadline ? `. Set it up by ${format.date(mfa.deadline)}.` : "."}
          </AlertDescription>
        </Alert>
      )}

      <ul className="flex flex-col divide-y">
        <Row>
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="text-sm font-medium">Password</span>
            <span className="text-xs text-muted-foreground">
              {!hasPassword
                ? "Not set."
                : passwordRefused
                  ? "Set, but not accepted while single sign-on is enforced."
                  : "Set."}
            </span>
            {signInProblem && (
              <span className="text-xs text-warn">{signInProblem}</span>
            )}
            {oauthOnlyNote && (
              <span className="text-xs text-muted-foreground">You sign in through your identity provider.</span>
            )}
          </span>
          <Button variant="outline" size="sm" className="shrink-0" onClick={onChangePassword}>
            {hasPassword ? "Change password" : "Set password"}
          </Button>
        </Row>

        <Row>
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="flex items-center gap-2">
              <span className="text-sm font-medium">Authenticator app</span>
              {mfa.authenticatorApp && <Badge variant="success">On</Badge>}
            </span>
            {!mfa.hasPassword ? (
              <span className="text-xs text-muted-foreground">Your identity provider handles multi-factor authentication.</span>
            ) : mfa.authenticatorApp ? (
              <>
                <span className={`text-xs ${remaining !== null && remaining <= 2 ? "text-warn" : "text-muted-foreground"}`}>
                  Backup codes: {remaining === null ? "unavailable" : `${remaining} of 10 left`}
                </span>
                {lastRequiredFactor("totp") && (
                  <span className="text-xs text-muted-foreground">
                    Your administrator requires multi-factor authentication, so it cannot be turned off.
                  </span>
                )}
              </>
            ) : (
              <span className="text-xs text-muted-foreground">A 6-digit code after your password, with backup codes.</span>
            )}
          </span>
          {mfa.hasPassword && (
            mfa.authenticatorApp ? (
              <span className="flex shrink-0 flex-wrap gap-2">
                <Button variant="outline" size="sm" onClick={() => setDialog({ kind: "regenerate", codes: null })}>
                  Generate new backup codes
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="text-destructive"
                  onClick={() => setDialog({ kind: "disable" })}
                  disabled={lastRequiredFactor("totp")}
                >
                  Turn off
                </Button>
              </span>
            ) : (
              <Button size="sm" className="shrink-0" onClick={() => setDialog({ kind: "setup" })}>
                Set up authenticator app
              </Button>
            )
          )}
        </Row>

        <Row>
          <span className="flex min-w-0 flex-1 flex-col gap-2">
            <span className="flex flex-col gap-0.5">
              <span className="text-sm font-medium">Passkeys</span>
              <span className="text-xs text-muted-foreground">Touch ID, Windows Hello or a security key instead of a password and code.</span>
            </span>
            {passkeys.length === 0 ? (
              <span className="text-xs text-muted-foreground">No passkeys yet.</span>
            ) : (
              <ul className="flex flex-col gap-2" aria-label="Your passkeys">
                {passkeys.map((passkey) => (
                  <li key={passkey.id} className="flex flex-wrap items-center gap-3 rounded-lg border bg-muted/30 px-3 py-2">
                    <KeyRound className="h-4 w-4 flex-none text-muted-foreground" aria-hidden="true" />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-sm font-medium">{passkey.name}</span>
                      <span className="text-xs text-muted-foreground">
                        {passkey.createdAt ? `Added ${format.date(passkey.createdAt)}` : "Added"}
                        {" · "}
                        {passkey.lastUsedAt ? `last used ${format.relative(passkey.lastUsedAt).toLowerCase()}` : "not used yet"}
                      </span>
                    </span>
                    <span className="flex gap-1">
                      <Button variant="ghost" size="sm" onClick={() => setDialog({ kind: "rename-passkey", passkey })} aria-label={`Rename passkey ${passkey.name}`}>
                        Rename
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive"
                        onClick={() => setDialog({ kind: "remove-passkey", passkey })}
                        disabled={lastRequiredFactor("passkey")}
                        aria-label={`Remove passkey ${passkey.name}`}
                      >
                        Remove
                      </Button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {passkeyBlocker && hasPassword && <span className="text-xs text-muted-foreground">{passkeyBlocker}</span>}
            {!webAuthn && <span className="text-xs text-muted-foreground">This browser cannot use passkeys.</span>}
          </span>
          {!passkeyBlocker && (
            <Button variant="outline" size="sm" className="shrink-0" onClick={() => setDialog({ kind: "add-passkey" })} disabled={!webAuthn}>
              <Plus className="h-4 w-4" />
              Add a passkey
            </Button>
          )}
        </Row>
      </ul>

      <Dialog open={dialog.kind !== "closed"} onOpenChange={(open) => !open && close()}>
        <DialogContent className="max-w-md">
          {dialog.kind === "setup" && (
            <>
              <DialogHeader>
                <DialogTitle>Set up an authenticator app</DialogTitle>
                <DialogDescription>Multi-factor authentication for password sign-in.</DialogDescription>
              </DialogHeader>
              <TotpEnrollment onDone={close} onCancel={close} />
            </>
          )}

          {dialog.kind === "regenerate" && (
            <>
              <DialogHeader>
                <DialogTitle>New backup codes</DialogTitle>
                <DialogDescription>Your current backup codes stop working.</DialogDescription>
              </DialogHeader>
              {dialog.codes ? (
                <div className="flex flex-col gap-4">
                  <BackupCodesPanel codes={dialog.codes} />
                  <div><Button onClick={close}>Done</Button></div>
                </div>
              ) : (
                <form onSubmit={regenerate} className="flex flex-col gap-3">
                  {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="mfa-regenerate-password">Password</Label>
                    <Input id="mfa-regenerate-password" name="password" type="password" autoComplete="current-password" required disabled={pending} />
                  </div>
                  <div className="flex gap-2">
                    <Button type="submit" disabled={pending}>Generate</Button>
                    <Button type="button" variant="ghost" onClick={close}>Cancel</Button>
                  </div>
                </form>
              )}
            </>
          )}

          {dialog.kind === "disable" && (
            <>
              <DialogHeader>
                <DialogTitle>Turn off the authenticator app</DialogTitle>
                <DialogDescription>
                  {mfa.passkeys > 0
                    ? "Your passkeys keep multi-factor authentication on. Your authenticator entry and backup codes stop working."
                    : "Your password alone will sign you in. Your authenticator entry and backup codes stop working."}
                </DialogDescription>
              </DialogHeader>
              <form onSubmit={disable} className="flex flex-col gap-3">
                {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="mfa-disable-password">Password</Label>
                  <Input id="mfa-disable-password" name="password" type="password" autoComplete="current-password" required disabled={pending} />
                </div>
                <div className="flex gap-2">
                  <Button type="submit" variant="destructive" disabled={pending}>Turn off</Button>
                  <Button type="button" variant="ghost" onClick={close}>Cancel</Button>
                </div>
              </form>
            </>
          )}

          {dialog.kind === "add-passkey" && (
            <>
              <DialogHeader>
                <DialogTitle>Add a passkey</DialogTitle>
                <DialogDescription>Your browser asks for Touch ID, Windows Hello, a PIN or a security key.</DialogDescription>
              </DialogHeader>
              <form onSubmit={createPasskey} className="flex flex-col gap-3">
                {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="passkey-name">Name</Label>
                  <Input id="passkey-name" name="name" maxLength={64} placeholder="For example: laptop, security key" disabled={pending} />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="passkey-password">Password</Label>
                  <Input id="passkey-password" name="password" type="password" autoComplete="current-password" required disabled={pending} />
                </div>
                <div className="flex gap-2">
                  <Button type="submit" disabled={pending}>{pending ? "Waiting for your passkey…" : "Continue"}</Button>
                  <Button type="button" variant="ghost" onClick={close}>Cancel</Button>
                </div>
              </form>
            </>
          )}

          {dialog.kind === "rename-passkey" && (
            <>
              <DialogHeader>
                <DialogTitle>Rename passkey</DialogTitle>
                <DialogDescription>Which device or key this is.</DialogDescription>
              </DialogHeader>
              <form onSubmit={(event) => renamePasskey(event, dialog.passkey)} className="flex flex-col gap-3">
                {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="passkey-rename">Name</Label>
                  <Input id="passkey-rename" name="name" maxLength={64} defaultValue={dialog.passkey.name} required disabled={pending} />
                </div>
                <div className="flex gap-2">
                  <Button type="submit" disabled={pending}>Save</Button>
                  <Button type="button" variant="ghost" onClick={close}>Cancel</Button>
                </div>
              </form>
            </>
          )}

          {dialog.kind === "remove-passkey" && (
            <>
              <DialogHeader>
                <DialogTitle>Remove passkey</DialogTitle>
                <DialogDescription>
                  &ldquo;{dialog.passkey.name}&rdquo; stops working on this dashboard. Remove it from the device or password manager too.
                </DialogDescription>
              </DialogHeader>
              {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
              <div className="flex gap-2">
                <Button variant="destructive" onClick={() => removePasskey(dialog.passkey)} disabled={pending}>Remove</Button>
                <Button variant="ghost" onClick={close}>Cancel</Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}
