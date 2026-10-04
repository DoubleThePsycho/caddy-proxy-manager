"use client";

import { useEffect, useRef } from "react";
import { ShieldCheck, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/button";
import { DiffView } from "@/components/ui/DiffView";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import type { HostChangePreview } from "@/ee/approvals/requests";
import { SECTION_LABELS, type FormChange } from "./changes";

export type PreviewState =
  | { status: "loading" }
  | { status: "ready"; preview: HostChangePreview & { warning: string | null } }
  | { status: "error"; message: string };

function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("en-GB", { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
}

function ApprovalNote({ preview, hostLabel }: { preview: HostChangePreview; hostLabel: string }) {
  const approval = preview.approval;
  if (!approval.required) {
    return (
      <Banner tone="ok" icon={ShieldCheck} title="No approval needed.">
        Saving applies the change at once.
      </Banner>
    );
  }
  const policies = approval.policies.map((policy) => `"${policy.name}"`).join(", ");
  const approvals = `${approval.requiredApprovals} ${approval.requiredApprovals === 1 ? "approval" : "approvals"}`;
  const window = approval.window.restricted
    ? ` and is applied in a change window, ${approval.window.description}.${approval.window.open ? " The window is open now." : approval.window.nextOpenAt ? ` The next window opens ${formatWhen(approval.window.nextOpenAt)}.` : " The windows of its policies do not open together in the coming week."}`
    : ". No change window applies, so it is applied as soon as it is approved.";
  return (
    <div role="note" className="flex gap-3 rounded-xl border border-line2 bg-warn-tint px-3.5 py-3">
      <ShieldCheck aria-hidden="true" className="mt-px h-[18px] w-[18px] shrink-0 text-warn" />
      <span className="flex flex-col gap-1 text-[13px]">
        <span className="font-semibold">This change needs approval</span>
        <span className="text-muted-foreground">
          {policies ? `${hostLabel} is covered by the change approval ${approval.policies.length === 1 ? "policy" : "policies"} ${policies}. ` : `A change approval policy covers ${hostLabel}. `}
          Saving creates a change request instead of applying it: it needs {approvals} from someone other than you{window}
        </span>
      </span>
    </div>
  );
}

export function ReviewPanel({
  title,
  changes,
  creating,
  preview,
  note,
  onNote,
  emergency,
  onEmergency,
  emergencyReason,
  onEmergencyReason,
  submitError,
  submitting,
  submitLabel,
  onSubmit,
  onClose,
  onShow,
  onUndo,
  hostLabel,
}: {
  title: string;
  changes: FormChange[];
  creating: boolean;
  preview: PreviewState;
  note: string;
  onNote: (value: string) => void;
  emergency: boolean;
  onEmergency: (value: boolean) => void;
  emergencyReason: string;
  onEmergencyReason: (value: string) => void;
  submitError: string | null;
  submitting: boolean;
  submitLabel: string;
  onSubmit: () => void;
  onClose: () => void;
  onShow: (change: FormChange) => void;
  onUndo: (change: FormChange) => void;
  hostLabel: string;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    headingRef.current?.focus();
  }, []);
  const ready = preview.status === "ready" ? preview.preview : null;
  const needsApproval = Boolean(ready?.approval.required);
  const minReason = ready?.approval.minEmergencyReasonLength ?? 10;
  const reasonShort = emergency && emergencyReason.trim().length < minReason;
  return (
    <section
      aria-labelledby="host-review-title"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        }
      }}
      className="flex max-h-[min(74vh,720px)] flex-col gap-3.5 overflow-y-auto rounded-2xl border border-line2 bg-panel px-4 py-4 shadow-overlay sm:px-5"
    >
      <div className="flex items-center gap-2.5">
        <h2 id="host-review-title" ref={headingRef} tabIndex={-1} className="m-0 flex-1 text-base font-semibold leading-6 outline-none">
          {title}
        </h2>
        <button type="button" onClick={onClose} aria-label="Close review" className="grid h-8 w-8 place-items-center rounded-lg text-muted-foreground hover:bg-raise hover:text-foreground">
          <X aria-hidden="true" className="h-4 w-4" />
        </button>
      </div>

      {changes.length === 0 ? (
        <p className="m-0 text-[13px] text-muted-foreground">{creating ? "The new host uses the default settings everywhere you did not change them." : "Nothing changed."}</p>
      ) : (
        <ol className="m-0 flex list-none flex-col gap-2.5 p-0" aria-label="Changes">
          {changes.map((change) => (
            <li key={change.group.id} className="flex flex-col gap-2 rounded-xl border border-line bg-panel2 px-3.5 py-3">
              <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                <span className="text-xs text-soft">{SECTION_LABELS[change.group.section]}</span>
                <span aria-hidden="true" className="text-soft">
                  /
                </span>
                <span className="font-semibold">{change.group.label}</span>
                <span className="ml-auto flex gap-1">
                  <button type="button" onClick={() => onShow(change)} className="h-7 rounded-md px-2 text-[13px] text-brand hover:bg-raise" aria-label={`Show ${change.group.label}`}>
                    Show
                  </button>
                  {!creating && (
                    <button type="button" onClick={() => onUndo(change)} className="h-7 rounded-md px-2 text-[13px] text-muted-foreground hover:bg-raise hover:text-foreground" aria-label={`Undo change to ${change.group.label}`}>
                      Undo
                    </button>
                  )}
                </span>
              </div>
              <DiffView lines={change.diff} label={`${change.group.label}: before and after`} context={2} />
            </li>
          ))}
        </ol>
      )}

      {preview.status === "loading" && (
        <p role="status" className="m-0 text-[13px] text-muted-foreground">
          Checking approval policies and impact…
        </p>
      )}
      {preview.status === "error" && (
        <Banner tone="bad" title="This change cannot be saved as it is." live>
          {preview.message}
        </Banner>
      )}
      {ready && (
        <>
          <ApprovalNote preview={ready} hostLabel={hostLabel} />
          <div className="flex flex-col gap-1.5">
            <span className="text-[13px] font-medium">Impact</span>
            <ul className="m-0 flex list-disc flex-col gap-1 pl-5 text-[13px] text-muted-foreground">
              {ready.impact.lines.map((line) => (
                <li key={line.key}>{line.text}</li>
              ))}
            </ul>
          </div>
          {ready.warning && <Banner tone="warn">{ready.warning}</Banner>}
          {needsApproval && !emergency && (
            <div className="flex flex-col gap-1.5">
              <label htmlFor="rv-reason" className="text-[13px] font-medium">
                Reason, shown to approvers
              </label>
              <Textarea id="rv-reason" rows={2} value={note} onChange={(event) => onNote(event.target.value)} placeholder="Ticket number and what the change is for" />
            </div>
          )}
          {needsApproval && ready.approval.emergencyAllowed && (
            <div className="flex flex-col gap-2.5 rounded-xl border border-line px-3.5 py-3">
              <div className="flex items-start gap-3.5">
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span id="rv-emergency-label" className="font-medium">
                    Emergency change
                  </span>
                  <span id="rv-emergency-desc" className="text-[13px] text-muted-foreground">
                    Apply now without approval and outside any change window. Needs a reason of at least {minReason} characters and is flagged in the audit log.
                  </span>
                </span>
                <Switch id="rv-emergency" checked={emergency} onCheckedChange={onEmergency} aria-labelledby="rv-emergency-label" aria-describedby="rv-emergency-desc" />
              </div>
              {emergency && (
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="rv-emergency-reason" className="text-[13px] font-medium">
                    Why it cannot wait
                  </label>
                  <Textarea
                    id="rv-emergency-reason"
                    rows={2}
                    value={emergencyReason}
                    onChange={(event) => onEmergencyReason(event.target.value)}
                    placeholder="Incident number and why it cannot wait"
                    aria-invalid={reasonShort && emergencyReason.length > 0 ? true : undefined}
                  />
                </div>
              )}
            </div>
          )}
        </>
      )}

      {submitError && (
        <Banner tone="bad" title="Not saved." live>
          {submitError}
        </Banner>
      )}

      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="outline" onClick={onClose}>
          Keep editing
        </Button>
        <Button
          type="button"
          variant={emergency ? "danger" : "default"}
          onClick={onSubmit}
          disabled={submitting || preview.status !== "ready" || reasonShort}
          className={cn(emergency && "border-bad")}
        >
          {submitting ? "Saving…" : submitLabel}
        </Button>
      </div>
    </section>
  );
}
