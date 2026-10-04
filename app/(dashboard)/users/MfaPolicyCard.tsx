"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ShieldCheck } from "lucide-react";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useFormat } from "@/src/components/preferences/PreferencesProvider";
import type { MfaPolicyScope } from "@/src/lib/mfa";
import { updateMfaPolicyAction } from "./mfa-actions";

export type MfaPolicySummary = {
  scope: MfaPolicyScope;
  graceDays: number;
  deadline: string | null;
  required: number;
  enrolled: number;
};

const SCOPE_LABELS: Record<MfaPolicyScope, string> = {
  off: "Not required",
  admins: "Required for administrators and custom roles",
  password_users: "Required for everyone who signs in with a password",
};

const SCOPE_SENTENCES: Record<MfaPolicyScope, string> = {
  off: "Multi-factor authentication is not required.",
  admins: "Multi-factor authentication is required for administrators and custom roles.",
  password_users: "Multi-factor authentication is required for everyone who signs in with a password.",
};

/** The policy in one line on the Users tab, with Edit policy for mfa_policy:write. */
export function MfaPolicyPanel({ policy, canEdit }: { policy: MfaPolicySummary; canEdit: boolean }) {
  const format = useFormat();
  const [editing, setEditing] = useState(false);
  return (
    <section
      aria-label="Multi-factor authentication policy"
      className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-line bg-panel px-4 py-3"
    >
      <span aria-hidden="true" className="grid h-[30px] w-[30px] shrink-0 place-items-center rounded-lg bg-raise text-muted-foreground">
        <ShieldCheck className="h-4 w-4" />
      </span>
      <div className="flex min-w-0 flex-[1_1_420px] flex-col gap-0.5 text-sm">
        <p className="m-0" data-testid="mfa-policy-summary">
          <span className="font-semibold">{SCOPE_SENTENCES[policy.scope]}</span>{" "}
          {policy.scope !== "off" && (
            <span className="text-muted-foreground">
              <span className="num">
                {policy.enrolled} of {policy.required}
              </span>{" "}
              covered account{policy.required === 1 ? "" : "s"} use it · <span className="num">{policy.graceDays}</span>-day grace period
              {policy.deadline ? ` ending ${format.date(policy.deadline)}` : ""}
            </span>
          )}
        </p>
        <p className="m-0 text-xs text-soft">
          Covered accounts without a second factor are asked to set one up when they sign in; after the grace period they can use
          the dashboard only to set it up. Accounts that sign in through an identity provider are asked by that provider instead.
        </p>
      </div>
      {canEdit && (
        <Button variant="link" size="sm" className="h-auto px-0" onClick={() => setEditing(true)}>
          Edit policy
        </Button>
      )}
      {canEdit && editing && <MfaPolicyDialog open onClose={() => setEditing(false)} policy={policy} />}
    </section>
  );
}

/** The administrators' MFA policy for dashboard sign-in (the same as PUT /api/v1/mfa/policy). */
export function MfaPolicyDialog({ open, onClose, policy }: { open: boolean; onClose: () => void; policy: MfaPolicySummary }) {
  const router = useRouter();
  const [scope, setScope] = useState<MfaPolicyScope>(policy.scope);
  const [graceDays, setGraceDays] = useState(String(policy.graceDays));
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const save = async () => {
    const days = Number(graceDays);
    if (!Number.isInteger(days) || days < 0 || days > 90) {
      setError("The grace period must be a whole number of days from 0 to 90.");
      return;
    }
    setError(null);
    setPending(true);
    try {
      const result = await updateMfaPolicyAction(scope, days);
      if (!result.ok) setError(result.error);
      else {
        onClose();
        router.refresh();
      }
    } catch {
      setError("Failed to save the MFA policy");
    }
    setPending(false);
  };

  const changed = scope !== policy.scope || graceDays !== String(policy.graceDays);

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Multi-factor authentication policy</DialogTitle>
          <DialogDescription>
            Require a second factor (an authenticator app with backup codes, or a passkey) for dashboard sign-in with a password.
            The grace period starts over when you change who is covered.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          {error && <Banner tone="bad" live>{error}</Banner>}
          <div className="space-y-1.5">
            <Label htmlFor="mfa-policy-scope">Policy</Label>
            <Select value={scope} onValueChange={(value) => setScope(value as MfaPolicyScope)}>
              <SelectTrigger id="mfa-policy-scope" data-testid="mfa-policy-scope">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(SCOPE_LABELS) as MfaPolicyScope[]).map((value) => (
                  <SelectItem key={value} value={value}>{SCOPE_LABELS[value]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="mfa-policy-grace">Grace period (days)</Label>
            <Input
              id="mfa-policy-grace"
              type="number"
              min={0}
              max={90}
              className="num max-w-40"
              value={graceDays}
              onChange={(event) => setGraceDays(event.target.value)}
              disabled={scope === "off"}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={save} disabled={pending || !changed}>{pending ? "Saving…" : "Save policy"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
