// SPDX-License-Identifier: Elastic-2.0
"use client";

/**
 * Shown in the host dialogs before saving: the host is protected by a change
 * approval policy, so saving submits a change request. Adds the optional
 * reason for approvers (changeNote) and, for users who may make emergency
 * changes, the emergency switch and its mandatory reason (emergencyReason).
 * The server decides again when the form is submitted.
 */
import { useState } from "react";
import { ShieldCheck, ShieldAlert } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { describePolicies, policiesCovering, policiesForbiddingEmergency, requiredApprovalsFor } from "../match";
import { describeWindows } from "../windows";
import { MIN_EMERGENCY_REASON_LENGTH, type HostApprovalContext, type Operation, type TargetType } from "../types";

export function ProtectedChangeNotice({
  approval,
  targetType,
  tags,
  operations,
}: {
  approval?: HostApprovalContext | null;
  targetType: TargetType;
  /** The host's tags (for a new host: the ones the form starts with). */
  tags: readonly string[];
  operations: readonly Operation[];
}) {
  const [emergency, setEmergency] = useState(false);
  if (!approval || approval.policies.length === 0) return null;
  const covering = policiesCovering(approval.policies, targetType, tags, operations);
  if (covering.length === 0) {
    // Tag-based policies may still cover a new host, depending on the tags it is given.
    const tagged = approval.policies.filter(
      (policy) =>
        policy.enabled &&
        policy.targetTypes.includes(targetType) &&
        policy.hostTags.length > 0 &&
        operations.some((operation) => policy.operations.includes(operation))
    );
    if (!operations.includes("create") || tagged.length === 0) return null;
    const protectedTags = [...new Set(tagged.flatMap((policy) => policy.hostTags))].sort();
    return (
      <p className="text-xs text-muted-foreground">
        A host tagged {protectedTags.join(", ")} needs approval before it is created.
      </p>
    );
  }

  const required = requiredApprovalsFor(covering);
  const windows = covering
    .filter((policy) => policy.windows.length > 0)
    .map((policy) => describeWindows(policy.windows, policy.timeZone))
    .join("; ");
  const emergencyAllowed = approval.canEmergency && policiesForbiddingEmergency(covering).length === 0;

  return (
    <div className="space-y-3">
      <Alert className="border-amber-500/50 bg-amber-500/5">
        <ShieldCheck className="h-4 w-4" />
        <AlertDescription>
          This host is protected by {describePolicies(covering)}. Saving submits a change request instead of applying it: it needs{" "}
          {required} approval{required === 1 ? "" : "s"} from someone other than you
          {windows ? ` and is applied in a change window (${windows})` : ""}. Track it on the Approvals page.
        </AlertDescription>
      </Alert>
      {!emergency && (
        <div className="space-y-1.5">
          <Label htmlFor="changeNote">Reason for the change (shown to approvers)</Label>
          <Textarea id="changeNote" name="changeNote" rows={2} placeholder="Ticket number and what the change is for" />
        </div>
      )}
      {emergencyAllowed && (
        <div className="space-y-2 rounded-md border border-red-500/40 p-3">
          <div className="flex items-center gap-2">
            <Switch id="emergencyChange" checked={emergency} onCheckedChange={setEmergency} />
            <Label htmlFor="emergencyChange" className="flex items-center gap-1.5">
              <ShieldAlert className="h-4 w-4 text-red-500" /> Emergency change: apply now without approval
            </Label>
          </div>
          {emergency && (
            <>
              <Textarea
                name="emergencyReason"
                rows={2}
                required
                minLength={MIN_EMERGENCY_REASON_LENGTH}
                placeholder="Incident number and why it cannot wait"
                aria-label="Emergency reason"
              />
              <p className="text-xs text-muted-foreground">
                The change is applied at once, outside any change window, and flagged as an emergency change in the audit log.
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
