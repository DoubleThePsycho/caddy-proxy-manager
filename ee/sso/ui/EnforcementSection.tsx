// SPDX-License-Identifier: Elastic-2.0
"use client";

import Link from "next/link";
import { useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { LockKeyhole } from "lucide-react";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { StatusDot, type StatusTone } from "@/components/ui/StatusDot";
import { useFormat } from "@/src/components/preferences/PreferencesProvider";
import { Fact, initials, plural } from "@/src/components/sign-in/source-card";
import type { SignInOverview } from "@/src/lib/sign-in-overview";
import { cn } from "@/lib/utils";

type Props = {
  enforcement: SignInOverview["enforcement"];
  canWriteSso: boolean;
  canReadAuditLog: boolean;
  /** saveSsoEnforcementAction (./actions.ts); turning enforcement off never needs a license. */
  turnOffEnforcement: (input: { enabled: boolean }) => Promise<{ ok: true } | { ok: false; error: string }>;
  /** What the login page offers now, shown beside the break-glass accounts. */
  loginOptions: ReactNode;
};

/**
 * Enforced single sign-on on the Sign-in and directories page: whether it is
 * on, the break-glass accounts and the correct passwords it refused, with
 * Turn off.
 */
export function EnforcementSection({ enforcement, canWriteSso, canReadAuditLog, turnOffEnforcement, loginOptions }: Props) {
  const router = useRouter();
  const format = useFormat();
  const [confirmOff, setConfirmOff] = useState(false);
  const [offError, setOffError] = useState<string | null>(null);
  const [turningOff, startTurningOff] = useTransition();

  const turnOff = () => {
    setOffError(null);
    startTurningOff(async () => {
      try {
        const result = await turnOffEnforcement({ enabled: false });
        if (!result.ok) {
          setOffError(result.error);
          return;
        }
        setConfirmOff(false);
        router.refresh();
      } catch {
        setOffError("Could not turn enforced single sign-on off. Try again.");
      }
    });
  };

  const changed = enforcement.changedAt
    ? `Turned ${enforcement.enabled ? "on" : "off"}${enforcement.changedBy ? ` by ${enforcement.changedBy}` : ""} on ${format.date(enforcement.changedAt)}. `
    : "";
  const breakGlassCount = enforcement.breakGlass.length;

  return (
    <>
      <section aria-labelledby="enforcement-title" className="flex min-w-0 flex-col overflow-hidden rounded-2xl border border-line bg-panel">
        <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2.5 border-b border-line px-5 py-4">
          <span
            aria-hidden="true"
            className={cn(
              "grid h-9 w-9 shrink-0 place-items-center rounded-[10px]",
              enforcement.enabled ? "bg-ok-tint text-ok" : "bg-raise text-muted-foreground"
            )}
          >
            <LockKeyhole className="h-[18px] w-[18px]" />
          </span>
          <span className="flex min-w-0 flex-[1_1_320px] flex-col gap-0.5">
            <span className="flex flex-wrap items-center gap-2">
              <h2 id="enforcement-title" className="m-0 text-base leading-6 font-semibold">
                {enforcement.enabled ? "Single sign-on is required for the dashboard" : "Single sign-on is not required"}
              </h2>
              <span
                className={cn(
                  "inline-flex h-[22px] items-center gap-1.5 rounded-full px-2 text-xs font-semibold",
                  enforcement.enabled ? "bg-ok-tint text-ok" : "bg-raise text-muted-foreground"
                )}
              >
                <span aria-hidden="true" className={cn("h-1.5 w-1.5 rounded-full", enforcement.enabled ? "bg-ok" : "bg-soft")} />
                {enforcement.enabled ? "On" : "Off"}
              </span>
            </span>
            <span className="text-[13px] text-muted-foreground">
              {changed}
              {enforcement.enabled
                ? `Password sign-in is refused for everyone except ${plural(breakGlassCount, "break-glass account")}, and nobody can register with a password.`
                : "Anyone with a password can sign in on the login page. Requiring single sign-on sends everyone through your identity provider and keeps break-glass accounts for outages."}
            </span>
          </span>
          <span className="flex flex-wrap gap-2">
            <Button asChild variant="secondary" size="sm">
              <Link href="/sso">{enforcement.enabled ? "Change break-glass accounts" : canWriteSso ? "Set up" : "Details"}</Link>
            </Button>
            {enforcement.enabled && canWriteSso && (
              <Button variant="danger" size="sm" onClick={() => setConfirmOff(true)}>
                Turn off
              </Button>
            )}
          </span>
        </div>

        {enforcement.warnings.length > 0 && (
          <div className="px-5 pt-4">
            <Banner tone="warn" layout="stacked" title="Check enforced single sign-on">
              <ul className="m-0 list-disc pl-4">
                {enforcement.warnings.map((warning) => <li key={warning}>{warning}</li>)}
              </ul>
            </Banner>
          </div>
        )}

        <div className="flex flex-wrap gap-5 px-5 pb-[18px] pt-4">
          <div className="flex min-w-0 flex-[2_1_420px] flex-col gap-3.5">
            <div className="flex flex-col gap-2">
              <span className="text-xs text-soft">{breakGlassCount === 1 ? "Break-glass account" : "Break-glass accounts"}</span>
              {breakGlassCount === 0 ? (
                <p className="m-0 rounded-xl border border-line bg-panel2 px-3.5 py-3 text-[13px] text-muted-foreground">
                  None chosen. Choose at least one administrator who can sign in with a password when the identity provider is down.
                </p>
              ) : (
                <ul className="m-0 flex list-none flex-col gap-2 p-0">
                  {enforcement.breakGlass.map((account) => {
                    const name = account.username ?? account.email;
                    const factors = [
                      account.passkeys > 0 ? (account.passkeys === 1 ? "Passkey" : `${account.passkeys} passkeys`) : null,
                      account.authenticatorApp ? "authenticator app" : null,
                    ].filter(Boolean).join(" and ");
                    const tone: StatusTone = account.passwordSignIn && account.status === "active" ? "ok" : "bad";
                    return (
                      <li key={account.id} className="flex flex-wrap items-center gap-x-3.5 gap-y-2.5 rounded-xl border border-line bg-panel2 px-3.5 py-3">
                        <span aria-hidden="true" className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-raise text-xs font-semibold text-muted-foreground">
                          {initials(account.name || name)}
                        </span>
                        <span className="flex min-w-0 flex-[1_1_200px] flex-col gap-0.5">
                          <span>
                            <span className="font-semibold">{name}</span>{" "}
                            <span className="text-muted-foreground">
                              {account.name ? `${account.name} · ` : ""}
                              {account.role === "admin" ? "Admin" : account.role}
                              {account.status !== "active" ? ` · ${account.status}` : ""}
                            </span>
                          </span>
                          <span className="text-xs text-soft">
                            {factors ? `${factors.charAt(0).toUpperCase()}${factors.slice(1)}` : "No second factor"}
                            {" · "}
                            {account.lastSignInAt ? <>last signed in <span className="num">{format.dateTime(account.lastSignInAt)}</span></> : "never signed in"}
                          </span>
                        </span>
                        <StatusDot
                          tone={tone}
                          label={tone === "ok" ? "Can sign in with a password" : "Cannot sign in with a password"}
                          className="text-[13px]"
                        />
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
            <dl className="m-0 grid grid-cols-[repeat(auto-fit,minmax(min(180px,100%),1fr))] gap-x-5 gap-y-3">
              <Fact label="Correct passwords refused, 7 days">
                <span className="flex flex-wrap items-baseline gap-2.5">
                  <span className="num">{enforcement.refusedLastWeek}</span>
                  {canReadAuditLog && enforcement.refusedLastWeek > 0 && (
                    <Link href="/audit-log?search=sso_enforced_sign_in_refused" className="text-[13px] text-brand underline-offset-4 hover:underline">
                      View in the audit log
                    </Link>
                  )}
                </span>
              </Fact>
              <Fact label="Covers">Dashboard sign-in only</Fact>
              <Fact label="Not affected">Forward-auth portal, API tokens</Fact>
            </dl>
          </div>
          {loginOptions}
        </div>
      </section>

      <Dialog open={confirmOff} onOpenChange={(next) => !next && setConfirmOff(false)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Turn off enforced single sign-on?</DialogTitle>
            <DialogDescription>
              Every account with a password can sign in with it again, and the login page shows the password form first. The
              break-glass list is kept for when you turn it back on.
            </DialogDescription>
          </DialogHeader>
          {offError && <Banner tone="bad" live>{offError}</Banner>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOff(false)}>Cancel</Button>
            <Button variant="danger" onClick={turnOff} disabled={turningOff}>{turningOff ? "Turning off…" : "Turn off"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
