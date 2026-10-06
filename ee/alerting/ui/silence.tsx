// SPDX-License-Identifier: Elastic-2.0
"use client";

/**
 * Dismissing alerts and muting rules on the Alerts page: the dialog, the
 * marker a dismissed or muted alert carries, and undoing either.
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { BellOff } from "lucide-react";
import { AppDialog } from "@/components/ui/AppDialog";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useFormat } from "@/components/preferences/PreferencesProvider";
import { cn } from "@/lib/utils";
import { MAX_SILENCE_NOTE_LENGTH, SILENCE_DURATIONS, type AlertEventView, type AlertSilenceView, type FiringAlertView } from "@/ee/alerting/types";
import { endAlertSilenceAction, silenceAlertAction } from "./actions";

/** What the dialog dismisses or mutes. */
export type SilenceTarget = { kind: "dismiss"; alert: FiringAlertView } | { kind: "mute"; rule: { id: number; name: string } };

export const DURATION_LABELS: Record<(typeof SILENCE_DURATIONS)[number], string> = {
  60: "1 hour",
  480: "8 hours",
  1440: "1 day",
  10080: "1 week",
};

type Choice = "resolve" | (typeof SILENCE_DURATIONS)[number];

/** Why a transition sent nothing, when a mute or dismissal held it back. */
export function silencedText(silenced: AlertEventView["silenced"]): string | null {
  if (silenced === "muted") return "Not sent (rule muted)";
  if (silenced === "dismissed") return "Not sent (dismissed)";
  return null;
}

/** A time today as its time of day, any other as date and time. */
function useWhen(now: number): (iso: string) => string {
  const format = useFormat();
  return (iso) => (format.date(iso) === format.date(new Date(now).toISOString()) ? format.time(iso) : format.dateTime(iso));
}

export function SilenceDialog({ open, target, onClose }: { open: boolean; target: SilenceTarget | null; onClose: () => void }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [wholeRule, setWholeRule] = useState(false);
  const [choice, setChoice] = useState<Choice>(target?.kind === "mute" ? 60 : "resolve");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  if (!target) return null;

  const muting = target.kind === "mute" || wholeRule;
  const rule = target.kind === "mute" ? target.rule : { id: target.alert.ruleId, name: target.alert.ruleName };
  const choices: Choice[] = muting ? [...SILENCE_DURATIONS] : ["resolve", ...SILENCE_DURATIONS];
  const hint = muting
    ? "No notifications for any of its alerts."
    : choice === "resolve"
      ? "Notifies again if it fires after it resolves."
      : "No notification if it fires again before then.";

  function toggleWholeRule(checked: boolean) {
    setWholeRule(checked);
    if (checked && choice === "resolve") setChoice(60);
  }

  function submit() {
    if (!target) return;
    setError(null);
    startTransition(async () => {
      const result = await silenceAlertAction({
        ruleId: rule.id,
        ...(muting || target.kind !== "dismiss" ? {} : { subjectKey: target.alert.subjectKey }),
        ...(choice === "resolve" ? {} : { durationMinutes: choice }),
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      toast.success(muting ? "Rule muted" : "Alert dismissed");
      onClose();
      router.refresh();
    });
  }

  return (
    <AppDialog
      open={open}
      onClose={onClose}
      title={target.kind === "mute" ? `Mute "${target.rule.name}"` : "Dismiss alert"}
      submitLabel={muting ? "Mute" : "Dismiss"}
      onSubmit={submit}
      isSubmitting={pending}
    >
      <div className="flex flex-col gap-4">
        {target.kind === "dismiss" && <p className="m-0 text-sm font-semibold [overflow-wrap:anywhere]">{target.alert.title}</p>}
        {target.kind === "dismiss" && (
          <label className="flex items-start gap-2 text-[13px]">
            <Checkbox className="mt-0.5" checked={wholeRule} onCheckedChange={(checked) => toggleWholeRule(checked === true)} />
            <span className="flex min-w-0 flex-col">
              Mute the whole rule instead
              <span className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{rule.name}</span>
            </span>
          </label>
        )}
        <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
          <legend className="mb-2 text-[13px] font-medium">{muting ? "Mute for" : "Dismiss"}</legend>
          <div className="grid grid-cols-2 gap-2">
            {choices.map((value) => {
              const checked = choice === value;
              return (
                <label
                  key={value}
                  className={cn(
                    "flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-[13px] whitespace-nowrap transition-colors",
                    value === "resolve" && "col-span-2",
                    checked ? "border-brand bg-brand-tint" : "border-line hover:bg-panel2"
                  )}
                >
                  <input
                    type="radio"
                    name="silence-duration"
                    value={String(value)}
                    checked={checked}
                    onChange={() => setChoice(value)}
                    className="h-4 w-4 shrink-0 accent-[var(--brand-fill)]"
                  />
                  {value === "resolve" ? "Until it resolves" : DURATION_LABELS[value]}
                </label>
              );
            })}
          </div>
          <p className="m-0 text-xs text-muted-foreground">{hint}</p>
        </fieldset>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="silence-note">
            Note <span className="font-normal text-muted-foreground">(optional)</span>
          </Label>
          <Textarea
            id="silence-note"
            rows={2}
            className="min-h-[64px]"
            maxLength={MAX_SILENCE_NOTE_LENGTH}
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
        </div>
        {error && (
          <Banner tone="bad" live>
            {error}
          </Banner>
        )}
      </div>
    </AppDialog>
  );
}

/** Undoes a dismissal or mute (never needs a license). */
export function useEndSilence(): { end: (silence: AlertSilenceView) => void; pending: boolean } {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  function end(silence: AlertSilenceView) {
    startTransition(async () => {
      const result = await endAlertSilenceAction(silence.id);
      if (result.ok) toast.success(silence.kind === "mute" ? "Rule unmuted" : "Dismissal undone");
      else toast.error(result.error);
      router.refresh();
    });
  }
  return { end, pending };
}

/** "Muted until 18:00", "Dismissed until Oct 9, 09:00" or "Dismissed". */
export function useSilenceHeadline(now: number): (silence: AlertSilenceView, muteLabel?: string) => string {
  const when = useWhen(now);
  return (silence, muteLabel = "Muted") => {
    const label = silence.kind === "mute" ? muteLabel : "Dismissed";
    return silence.until ? `${label} until ${when(silence.until)}` : label;
  };
}

/**
 * A dismissed alert's or muted rule's marker: what, who (and when, for a
 * dismissal until it resolves), the note, and Undo for writers.
 */
export function SilenceMarker({
  silence,
  now,
  muteLabel,
  undo,
  undoLabel,
}: {
  silence: AlertSilenceView;
  now: number;
  /** How a mute reads, e.g. "Rule muted" on an alert. */
  muteLabel?: string;
  /** Present for writers. */
  undo?: { label: string; onClick: () => void; disabled: boolean };
  /** Accessible name of the Undo button. */
  undoLabel?: string;
}) {
  const when = useWhen(now);
  const headline = useSilenceHeadline(now)(silence, muteLabel);
  const parts = [
    silence.createdByName ? { text: silence.createdByName, time: false } : null,
    silence.until ? null : { text: when(silence.createdAt), time: true },
  ].filter((part): part is { text: string; time: boolean } => part !== null);
  return (
    <div className="flex min-w-0 flex-col gap-0.5 text-[13px]" data-testid="silence-marker">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <BellOff aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span>
          <span className="font-semibold">{headline}</span>
          {parts.map((part) => (
            <span key={part.text} className="text-muted-foreground">
              {" · "}
              <span className={part.time ? "num" : undefined}>{part.text}</span>
            </span>
          ))}
        </span>
        {undo && (
          <Button variant="link" size="sm" className="h-auto px-0 py-0" onClick={undo.onClick} disabled={undo.disabled} aria-label={undoLabel}>
            {undo.label}
          </Button>
        )}
      </div>
      {silence.note && <p className="m-0 pl-[22px] whitespace-pre-line text-muted-foreground [overflow-wrap:anywhere]">{silence.note}</p>}
    </div>
  );
}
