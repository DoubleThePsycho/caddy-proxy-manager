"use client";

import { FormEvent, useState, useSyncExternalStore } from "react";
import { KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Banner } from "@/components/ui/Banner";
import { TotpEnrollment } from "@/src/components/mfa/TotpEnrollment";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AuthBrand } from "@/src/components/auth/AuthBrand";
import { addPasskey, describePasskeyError, passkeysSupported } from "@/src/components/passkeys/passkey-api";
import { formatAppVersion } from "@/src/lib/app-version";
import { useBranding } from "@/ee/white-label/ui/BrandingProvider";
import { BrandFooter } from "@/ee/white-label/ui/BrandParts";
import type { MfaGate } from "@/src/lib/mfa";

function formatDeadline(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** A full load of the dashboard, with its own document and CSP nonce. */
function goToDashboard() {
  window.location.replace("/");
}

const noSubscription = () => () => {};

/** A passkey instead of an authenticator app: it counts as multi-factor authentication too. */
function PasskeyAlternative() {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const webAuthn = useSyncExternalStore(noSubscription, passkeysSupported, () => false);
  if (!webAuthn) return null;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const password = String(form.get("password") ?? "");
    if (!password) {
      setError("Enter your password.");
      return;
    }
    setError(null);
    setPending(true);
    const result = await addPasskey(password, String(form.get("name") ?? ""));
    setPending(false);
    if (!result.ok) {
      setError(describePasskeyError(result.error));
      return;
    }
    goToDashboard();
  };

  if (!open) {
    return (
      <Button type="button" variant="outline" className="h-10 w-full rounded-lg" onClick={() => setOpen(true)}>
        <KeyRound aria-hidden="true" />
        Use a passkey instead
      </Button>
    );
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-3 rounded-xl border border-line bg-panel2 p-3.5" data-testid="mfa-setup-passkey">
      <p className="m-0 text-[13px] text-muted-foreground">
        A passkey (Touch ID, Windows Hello, a PIN or a security key) signs you in instead of your password and a code.
      </p>
      {error && <Banner tone="bad" live>{error}</Banner>}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="setup-passkey-name">Name</Label>
        <Input id="setup-passkey-name" name="name" maxLength={64} placeholder="For example: laptop" disabled={pending} className="h-10 rounded-lg" />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="setup-passkey-password">Password</Label>
        <Input
          id="setup-passkey-password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          disabled={pending}
          className="h-10 rounded-lg"
        />
      </div>
      <Button type="submit" className="h-10 rounded-lg" disabled={pending}>
        {pending ? "Waiting for your passkey…" : "Add a passkey"}
      </Button>
    </form>
  );
}

/**
 * The MFA setup page outside the dashboard, laid out like the sign-in page:
 * the brand above one card, the policy that sends the person here, the
 * authenticator app steps and, where the browser supports it, a passkey.
 */
export default function MfaSetupClient({
  gate,
  deadline,
  canAddPasskey = false,
}: {
  gate: MfaGate;
  deadline: string | null;
  /** The account may add a passkey (src/lib/passkeys.ts). */
  canAddPasskey?: boolean;
}) {
  const [enabled, setEnabled] = useState(false);
  const branding = useBranding();
  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center bg-background px-4 pb-24 pt-12">
      <main className="flex w-full max-w-[440px] flex-col gap-6">
        <AuthBrand />

        <section aria-labelledby="mfa-setup-title" className="flex flex-col gap-5 rounded-2xl border border-line bg-panel p-7 text-card-foreground max-sm:p-5">
          <div className="flex flex-col gap-1">
            <h1 id="mfa-setup-title" className="m-0 text-2xl font-semibold leading-8 tracking-tight">
              Set up multi-factor authentication
            </h1>
            <p className="m-0 text-muted-foreground [text-wrap:pretty]">
              A code from an authenticator app, or a passkey, as a second step when you sign in to {branding.productName}.
            </p>
          </div>

          {!enabled && gate === "required" && (
            <Banner tone="bad" layout="stacked" title="Required for your account">
              Your administrator requires multi-factor authentication for your account. Set it up to continue.
            </Banner>
          )}
          {!enabled && gate === "prompt" && (
            <Banner tone="warn" layout="stacked" title="Required for your account">
              Your administrator requires multi-factor authentication for your account
              {deadline ? `. Set it up by ${formatDeadline(deadline)}; after that you cannot use the dashboard without it.` : "."}
            </Banner>
          )}

          <TotpEnrollment onDone={goToDashboard} onEnabled={() => setEnabled(true)} doneLabel="Continue to the dashboard" />

          {!enabled && canAddPasskey && (
            <div className="flex flex-col gap-3 border-t border-line pt-4">
              <PasskeyAlternative />
            </div>
          )}

          <div className="flex items-center justify-between gap-3 border-t border-line pt-3">
            {!enabled && gate !== "required" ? (
              <Button type="button" variant="ghost" size="sm" className="-ml-2.5 text-muted-foreground" onClick={goToDashboard}>
                Remind me later
              </Button>
            ) : (
              <span />
            )}
            <form action="/api/auth/logout" method="POST">
              <Button type="submit" variant="ghost" size="sm" className="-mr-2.5 text-muted-foreground">
                Sign out
              </Button>
            </form>
          </div>
        </section>

        <BrandFooter branding={branding} />
      </main>

      <footer className="absolute inset-x-0 bottom-8 flex flex-wrap items-center justify-center gap-x-3.5 gap-y-2 text-xs text-soft">
        <span title="Application version">
          {branding.productName} <span className="num">{formatAppVersion()}</span>
        </span>
      </footer>
    </div>
  );
}
