"use client";

import { FormEvent, useState } from "react";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { BackupCodesPanel } from "./BackupCodesPanel";
import { QrCode } from "./QrCode";
import { describeMfaError, manualEntryKey, mfaApi } from "./mfa-api";

type Step =
  | { kind: "password" }
  | { kind: "scan"; totpURI: string; backupCodes: string[] }
  | { kind: "codes"; backupCodes: string[] };

/**
 * Setting up an authenticator app: confirm the password, scan the QR code
 * (or type the key), confirm one code, then save the backup codes. MFA is on
 * from the moment the code is confirmed.
 */
export function TotpEnrollment({
  onDone,
  onCancel,
  onEnabled,
  doneLabel = "Done",
}: {
  /** Called after the backup codes were shown and the person moves on. */
  onDone: () => void;
  onCancel?: () => void;
  /** Called as soon as MFA is on (before the backup codes are shown). */
  onEnabled?: () => void;
  doneLabel?: string;
}) {
  const [step, setStep] = useState<Step>({ kind: "password" });
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const start = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const password = String(new FormData(event.currentTarget).get("password") ?? "");
    if (!password) {
      setError("Enter your password.");
      return;
    }
    setError(null);
    setPending(true);
    const result = await mfaApi.enable(password);
    setPending(false);
    if (!result.ok) {
      setError(describeMfaError(result.error));
      return;
    }
    setStep({ kind: "scan", totpURI: result.data.totpURI, backupCodes: result.data.backupCodes });
  };

  const confirm = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (step.kind !== "scan") return;
    const code = String(new FormData(event.currentTarget).get("code") ?? "").replace(/\s+/g, "");
    if (!/^\d{6}$/.test(code)) {
      setError("Enter the 6-digit code from your authenticator app.");
      return;
    }
    setError(null);
    setPending(true);
    const result = await mfaApi.verifyTotp(code);
    setPending(false);
    if (!result.ok) {
      setError(describeMfaError(result.error));
      return;
    }
    setStep({ kind: "codes", backupCodes: step.backupCodes });
    onEnabled?.();
  };

  return (
    <div className="flex flex-col gap-4">
      {error && (
        <Banner tone="bad" live>
          {error}
        </Banner>
      )}

      {step.kind === "password" && (
        <form onSubmit={start} className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">
            You need an authenticator app, such as a password manager, Google Authenticator, Microsoft
            Authenticator or Aegis. Confirm your password to start.
          </p>
          <div className="space-y-1.5">
            <Label htmlFor="mfa-password">Password</Label>
            <Input id="mfa-password" name="password" type="password" autoComplete="current-password" required disabled={pending} />
          </div>
          <div className="flex gap-2">
            <Button type="submit" disabled={pending}>{pending ? "Checking…" : "Continue"}</Button>
            {onCancel && <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>}
          </div>
        </form>
      )}

      {step.kind === "scan" && (
        <form onSubmit={confirm} className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">
            Scan this QR code with your authenticator app, then enter the 6-digit code it shows.
          </p>
          <div className="flex flex-col items-center gap-3">
            <QrCode value={step.totpURI} label="QR code to add this account to an authenticator app" />
            <div className="text-center">
              <p className="text-xs text-muted-foreground">Can&apos;t scan it? Enter this key instead:</p>
              <code className="num select-all break-words text-sm" data-testid="mfa-manual-key">{manualEntryKey(step.totpURI)}</code>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="mfa-setup-code">Code from the app</Label>
            <Input
              id="mfa-setup-code"
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="123456"
              maxLength={7}
              required
              disabled={pending}
              autoFocus
            />
          </div>
          <div className="flex gap-2">
            <Button type="submit" disabled={pending}>{pending ? "Verifying…" : "Turn on MFA"}</Button>
            {onCancel && <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>}
          </div>
        </form>
      )}

      {step.kind === "codes" && (
        <div className="flex flex-col gap-4">
          <p role="status" className="m-0 text-sm font-medium text-ok">
            Multi-factor authentication is on.
          </p>
          <BackupCodesPanel codes={step.backupCodes} />
          <div>
            <Button type="button" onClick={onDone}>{doneLabel}</Button>
          </div>
        </div>
      )}
    </div>
  );
}
