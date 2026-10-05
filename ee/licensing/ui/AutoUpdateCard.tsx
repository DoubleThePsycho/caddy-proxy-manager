// SPDX-License-Identifier: Elastic-2.0
"use client";

import { useId, useState, useTransition, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StatusChip } from "@/components/ui/StatusChip";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { formatDateTimeUtc } from "@/src/lib/date-format";
import type { LicenseAutoUpdateView } from "@/ee/licensing/auto-update";
import { checkLicenseServerNowAction, setLicenseAutoUpdateAction, type LicenseAutoUpdateActionResult } from "./actions";

const TOKEN_PATTERN = /^lrt_[A-Za-z0-9_-]{43}$/;

export const AUTO_UPDATE_STATUS: Record<
  LicenseAutoUpdateView["status"],
  { status: "active" | "inactive" | "warning"; label: string }
> = {
  on: { status: "active", label: "On" },
  off: { status: "inactive", label: "Off" },
  disabled_by_env: { status: "inactive", label: "Turned off by the environment" },
  replica: { status: "inactive", label: "Replica: never checks" },
  invalid_endpoint: { status: "warning", label: "Not checking" },
  license_mismatch: { status: "warning", label: "Token for another license" },
  no_license: { status: "inactive", label: "No license to update" },
};

/** What the last check came to, in a few words. */
export function describeLastResult(view: Pick<LicenseAutoUpdateView, "lastResult" | "lastError">): string {
  switch (view.lastResult) {
    case "updated":
      return "Installed a newer key";
    case "current":
      return "The installed key is the newest";
    case "revoked":
      return "The license server says this license was revoked; the installed key keeps working until it expires";
    case "failed":
      return `Failed: ${view.lastError ?? "no answer"}`;
    default:
      return "No check yet";
  }
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-line py-2.5">
      <dt className="flex-[0_0_120px] text-[13px] text-muted-foreground">{label}</dt>
      <dd className="m-0 flex min-w-0 flex-[1_1_200px] flex-wrap items-center gap-x-2.5 gap-y-1.5 text-[13px] [overflow-wrap:anywhere]">
        {children}
      </dd>
    </div>
  );
}

function when(value: string | null, never = "Never"): string {
  return value ? formatDateTimeUtc(value) : never;
}

function hostOf(url: string | null): string {
  if (!url) return "the license server";
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export type AutoUpdateCardProps = {
  initial: LicenseAutoUpdateView;
  /** The user may change the license (license:write). */
  canWrite: boolean;
  /** Id of the installed license when it is valid (possibly expired); null without one. */
  installedLicenseId: string | null;
};

/** "Keep the license up to date automatically": the switch, the refresh token and the last results. */
export function AutoUpdateCard({ initial, canWrite, installedLicenseId }: AutoUpdateCardProps) {
  const router = useRouter();
  const headingId = useId();
  const switchId = useId();
  const tokenId = useId();
  const tokenHelpId = useId();
  const [view, setView] = useState(initial);
  const [editing, setEditing] = useState(false);
  const [token, setToken] = useState("");
  const [message, setMessage] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  const chip = AUTO_UPDATE_STATUS[view.status];
  const blocked = view.disabledByEnv || view.role === "slave" || view.endpointError !== null;
  const canTurnOn = canWrite && !blocked && installedLicenseId !== null;
  const trimmed = token.trim();
  const tokenLooksValid = TOKEN_PATTERN.test(trimmed);

  function run(action: () => Promise<LicenseAutoUpdateActionResult>, success: (next: LicenseAutoUpdateView) => string) {
    setMessage(null);
    startTransition(async () => {
      const result = await action();
      if (result.ok) {
        setView(result.view);
        setEditing(false);
        setToken("");
        setMessage({ tone: "ok", text: success(result.view) });
        router.refresh();
      } else {
        setMessage({ tone: "bad", text: result.error });
      }
    });
  }

  function afterCheck(next: LicenseAutoUpdateView): string {
    return next.lastResult === "updated"
      ? "A newer key was installed."
      : next.lastResult === "current"
        ? "The license server was asked; the installed key is the newest."
        : describeLastResult(next);
  }

  function submitToken(event: FormEvent) {
    event.preventDefault();
    if (!tokenLooksValid) {
      setMessage({ tone: "bad", text: "Paste the refresh token from the license e-mail: lrt_ followed by 43 characters." });
      return;
    }
    const replacing = view.enabled;
    run(
      () => setLicenseAutoUpdateAction(true, trimmed),
      (next) => `${replacing ? "Refresh token replaced." : "Automatic updates are on."} ${afterCheck(next)}`
    );
  }

  function toggle(checked: boolean) {
    setMessage(null);
    if (checked) {
      setEditing(true);
      return;
    }
    setEditing(false);
    // Switched back before a token was saved: nothing is stored yet.
    if (!view.enabled) {
      setToken("");
      return;
    }
    run(
      () => setLicenseAutoUpdateAction(false),
      () => "Automatic updates are off and the stored refresh token was deleted."
    );
  }

  return (
    <section
      aria-labelledby={headingId}
      className="flex min-w-0 flex-[1_1_100%] flex-col gap-3.5 rounded-2xl border border-line bg-panel px-5 pt-[18px] pb-5"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h2 id={headingId} className="m-0 text-base leading-6 font-semibold">
          Automatic updates
        </h2>
        <StatusChip status={chip.status} label={chip.label} className="shrink-0" />
      </div>

      <div className="flex flex-wrap items-start gap-x-8 gap-y-4">
        <div className="flex min-w-0 flex-[1_1_380px] flex-col gap-3">
          <p className="m-0 text-[13px] text-muted-foreground [text-wrap:pretty]">
            Once a day, asks {hostOf(view.endpoint)} for the current key of the installed license, sending only the license id and its
            refresh token. Renewals then arrive without pasting a key.
          </p>

          {view.disabledByEnv && (
            <Banner tone="info">
              <code className="num text-xs">LICENSE_AUTO_UPDATE_DISABLED</code> turns automatic updates off on this install.
            </Banner>
          )}
          {!view.disabledByEnv && view.role === "slave" && (
            <Banner tone="info">This instance is a sync replica: turn this on on the master.</Banner>
          )}
          {view.endpointError && <Banner tone="bad">{view.endpointError}. Nothing is sent until it is fixed.</Banner>}
          {view.status === "license_mismatch" && (
            <Banner tone="warn" title="The stored refresh token belongs to another license.">
              Nothing is sent. Enter the refresh token of the installed license, or turn automatic updates off.
            </Banner>
          )}
          {view.status === "off" && installedLicenseId === null && !blocked && (
            <p className="m-0 text-xs text-soft">Install a license key first; automatic updates keep that license up to date.</p>
          )}

          <div className="flex min-h-9 items-center gap-2.5">
            <Switch
              id={switchId}
              checked={view.enabled || editing}
              disabled={pending || !canWrite || (!view.enabled && !canTurnOn)}
              onCheckedChange={toggle}
            />
            <Label htmlFor={switchId} className="font-medium">
              Keep the license up to date automatically
            </Label>
          </div>

          {canWrite && (editing || (view.enabled && view.status === "license_mismatch")) && (
            <form onSubmit={submitToken} className="flex flex-col gap-1.5">
              <label htmlFor={tokenId} className="font-medium">
                Refresh token
              </label>
              <div className="flex flex-wrap items-center gap-2.5">
                <Input
                  id={tokenId}
                  type="password"
                  value={token}
                  onChange={(event) => setToken(event.target.value)}
                  placeholder="lrt_…"
                  autoComplete="off"
                  spellCheck={false}
                  aria-describedby={tokenHelpId}
                  aria-invalid={trimmed.length > 0 && !tokenLooksValid}
                  className="num min-w-0 flex-[1_1_260px] bg-background text-xs md:text-xs"
                />
                <Button type="submit" disabled={pending || trimmed.length === 0}>
                  {pending ? "Checking…" : view.enabled ? "Save token" : "Turn on"}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={pending}
                  onClick={() => {
                    setEditing(false);
                    setToken("");
                    setMessage(null);
                  }}
                >
                  Cancel
                </Button>
              </div>
              <span id={tokenHelpId} className="text-xs text-soft">
                From the e-mail with your license key{installedLicenseId ? ` (license ${installedLicenseId})` : ""}. Saving it checks it with
                the license server.
              </span>
            </form>
          )}

          {!canWrite && (
            <p className="m-0 text-xs text-soft">Your role can see this setting but not change it.</p>
          )}

          <div role="status" aria-live="polite">
            {message && (
              <p className={cn("m-0 text-[13px] font-medium", message.tone === "ok" ? "text-ok" : "text-bad")}>{message.text}</p>
            )}
          </div>

          {canWrite && view.enabled && !editing && (
            <div className="flex flex-wrap items-center gap-2.5">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={pending || view.status !== "on"}
                onClick={() => run(checkLicenseServerNowAction, afterCheck)}
              >
                <RefreshCw aria-hidden="true" />
                {pending ? "Checking…" : "Check now"}
              </Button>
              <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={() => setEditing(true)}>
                Replace refresh token
              </Button>
            </div>
          )}
        </div>

        <dl className="m-0 flex min-w-0 flex-[1_1_320px] flex-col">
          <Row label="License server">
            <code className="num text-xs">{view.endpoint ?? "None"}</code>
          </Row>
          <Row label="License">{view.licenseId ? <span className="num">{view.licenseId}</span> : "None"}</Row>
          <Row label="Last check">{when(view.lastCheckAt)}</Row>
          <Row label="Result">{describeLastResult(view)}</Row>
          <Row label="Next check">{view.nextCheckAt ? formatDateTimeUtc(view.nextCheckAt) : "Not scheduled"}</Row>
          <Row label="Last update">{when(view.lastUpdatedAt)}</Row>
        </dl>
      </div>
    </section>
  );
}
