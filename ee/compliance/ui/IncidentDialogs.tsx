// SPDX-License-Identifier: Elastic-2.0
"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { AppDialog } from "@/components/ui/AppDialog";
import { Banner } from "@/components/ui/Banner";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useFormat } from "@/components/preferences/PreferencesProvider";
import {
  ASSESSMENT_QUESTIONS,
  CLASSIFICATION_LABELS,
  MAX_CAUSE_CHARS,
  MAX_REASON_CHARS,
  MAX_TIMELINE_TEXT,
  suggestedClassification,
  type AssessmentKey,
  type Classification,
  type IncidentAssessment,
} from "../incident-register";
import { INCIDENT_LANGUAGE_LABELS, INCIDENT_LANGUAGES, type ChoiceValue, type IncidentLanguage, type IncidentView } from "../types";
import type { DraftSources } from "./IncidentRegister";
import { callApi, Field, fromLocalInput, toLocalInput } from "./shared";

const NO_ALERT = "none";
const ANSWERS: { value: ChoiceValue; label: string }[] = [
  { value: "yes", label: "Yes" },
  { value: "no", label: "No" },
  { value: "unknown", label: "Not known yet" },
];
const CLASSIFICATIONS: Classification[] = ["undetermined", "not_significant", "significant"];

function ErrorBanner({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <Banner tone="bad" live>
      {error}
    </Banner>
  );
}

/** Records a new incident in the register, optionally from an alert. Needs the license. */
export function RecordIncidentDialog({
  sources,
  onClose,
  onCreated,
}: {
  sources: DraftSources;
  onClose: () => void;
  onCreated: (incident: IncidentView) => void;
}) {
  const format = useFormat();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [alertId, setAlertId] = useState(NO_ALERT);
  const [detectedAt, setDetectedAt] = useState(() => toLocalInput(new Date().toISOString()));
  const [startedAt, setStartedAt] = useState("");
  const [endedAt, setEndedAt] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [hostIds, setHostIds] = useState<number[]>([]);
  const [language, setLanguage] = useState<IncidentLanguage>("en");

  function chooseAlert(value: string) {
    setAlertId(value);
    const event = sources.alertEvents.find((candidate) => String(candidate.id) === value);
    if (event) setDetectedAt(toLocalInput(event.at));
  }

  function create() {
    const body: Record<string, unknown> = { language, proxyHostIds: hostIds };
    if (title.trim()) body.title = title.trim();
    if (alertId !== NO_ALERT) body.alertEventId = Number(alertId);
    const times: [string, string][] = [
      ["detectedAt", detectedAt],
      ["startedAt", startedAt],
      ["endedAt", endedAt],
      ["from", from],
      ["to", to],
    ];
    for (const [key, value] of times) {
      const iso = fromLocalInput(value);
      if (iso) body[key] = iso;
    }
    startTransition(async () => {
      try {
        const incident = await callApi<IncidentView>("/incidents", "POST", body);
        toast.success("Incident recorded");
        onCreated(incident);
      } catch (err) {
        setError((err as Error).message);
      }
    });
  }

  return (
    <AppDialog open onClose={onClose} title="Record an incident" maxWidth="lg" submitLabel="Record" onSubmit={create} isSubmitting={pending}>
      <div className="flex flex-col gap-4">
        <Field label="Start from an alert (optional)" htmlFor="incident-alert" hint="Takes the alert's title and time; its facts are included.">
          <Select value={alertId} onValueChange={chooseAlert}>
            <SelectTrigger id="incident-alert" aria-label="Alert">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_ALERT}>No alert</SelectItem>
              {sources.alertEvents.map((event) => (
                <SelectItem key={event.id} value={String(event.id)}>
                  {format.dateTime(event.at)} · {event.severity} · {event.title.slice(0, 80)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label="Title" htmlFor="incident-title" hint={alertId === NO_ALERT ? undefined : "Leave empty to use the alert's title."}>
          <Input id="incident-title" value={title} maxLength={200} onChange={(event) => setTitle(event.target.value)} />
        </Field>
        <Field label="Became aware of it at (your time zone)" htmlFor="incident-detected" hint="The notification deadlines of a significant incident run from this time.">
          <Input id="incident-detected" type="datetime-local" value={detectedAt} onChange={(event) => setDetectedAt(event.target.value)} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Started at (optional)" htmlFor="incident-started" hint="Leave empty while unknown.">
            <Input id="incident-started" type="datetime-local" value={startedAt} onChange={(event) => setStartedAt(event.target.value)} />
          </Field>
          <Field label="Ended at (optional)" htmlFor="incident-ended" hint="Leave empty while it is still going on.">
            <Input id="incident-ended" type="datetime-local" value={endedAt} onChange={(event) => setEndedAt(event.target.value)} />
          </Field>
        </div>
        <Field label="Affected proxy hosts" hint="None selected: figures cover every host.">
          <div className="max-h-48 space-y-1 overflow-y-auto rounded-lg border border-line p-2">
            {sources.proxyHosts.length === 0 && <p className="text-xs text-muted-foreground">No proxy hosts.</p>}
            {sources.proxyHosts.map((host) => (
              <label key={host.id} className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={hostIds.includes(host.id)}
                  onCheckedChange={(checked) => setHostIds((current) => (checked ? [...current, host.id] : current.filter((id) => id !== host.id)))}
                />
                {host.name}
              </label>
            ))}
          </div>
        </Field>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Figures from (optional)" htmlFor="incident-from" hint="Default: 24 hours before you became aware.">
            <Input id="incident-from" type="datetime-local" value={from} onChange={(event) => setFrom(event.target.value)} />
          </Field>
          <Field label="Figures to (optional)" htmlFor="incident-to" hint="Default: now. At most 31 days in all.">
            <Input id="incident-to" type="datetime-local" value={to} onChange={(event) => setTo(event.target.value)} />
          </Field>
          <Field label="Language of the drafts" htmlFor="incident-language">
            <Select value={language} onValueChange={(value) => setLanguage(value as IncidentLanguage)}>
              <SelectTrigger id="incident-language" aria-label="Language">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {INCIDENT_LANGUAGES.map((value) => (
                  <SelectItem key={value} value={value}>
                    {INCIDENT_LANGUAGE_LABELS[value]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>
        <ErrorBanner error={error} />
      </div>
    </AppDialog>
  );
}

/** The NIS2 Article 23(3) assessment, the classification, the window and the cause. Needs no license. */
export function AssessDialog({ incident, onClose, onSaved }: { incident: IncidentView; onClose: () => void; onSaved: (incident: IncidentView) => void }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [assessment, setAssessment] = useState<IncidentAssessment>(() => structuredClone(incident.assessment));
  const [classification, setClassification] = useState<Classification>(incident.classification);
  const [cause, setCause] = useState(incident.cause ?? "");
  const initialStarted = toLocalInput(incident.startedAt);
  const initialEnded = toLocalInput(incident.endedAt);
  const [startedAt, setStartedAt] = useState(initialStarted);
  const [endedAt, setEndedAt] = useState(initialEnded);
  const suggestion = suggestedClassification(assessment);

  function setAnswer(key: AssessmentKey, change: Partial<IncidentAssessment[AssessmentKey]>) {
    setAssessment((current) => ({ ...current, [key]: { ...current[key], ...change } }));
  }

  /** Only what changed: unchanged times keep their seconds. */
  function save() {
    const body: Record<string, unknown> = {};
    const answers: Record<string, { answer: ChoiceValue; reason: string }> = {};
    for (const question of ASSESSMENT_QUESTIONS) {
      const next = assessment[question.key];
      const before = incident.assessment[question.key];
      if (next.answer !== before.answer || next.reason.trim() !== before.reason) answers[question.key] = { answer: next.answer, reason: next.reason.trim() };
    }
    if (Object.keys(answers).length > 0) body.assessment = answers;
    if (classification !== incident.classification) body.classification = classification;
    if (cause.trim() !== (incident.cause ?? "")) body.cause = cause.trim() || null;
    if (startedAt !== initialStarted) body.startedAt = fromLocalInput(startedAt);
    if (endedAt !== initialEnded) body.endedAt = fromLocalInput(endedAt);
    if (Object.keys(body).length === 0) {
      onClose();
      return;
    }
    startTransition(async () => {
      try {
        onSaved(await callApi<IncidentView>(`/incidents/${incident.id}`, "PUT", body));
      } catch (err) {
        setError((err as Error).message);
      }
    });
  }

  return (
    <AppDialog open onClose={onClose} title={`Assess “${incident.title}”`} maxWidth="lg" submitLabel="Save" onSubmit={save} isSubmitting={pending}>
      <div className="flex flex-col gap-5">
        <p className="m-0 text-[13px] text-muted-foreground">
          An incident is significant under NIS2 Article 23(3) when it caused, or can cause, severe operational disruption or financial loss, or
          considerable damage to other people or organisations. The last two answers go into the early warning.
        </p>
        {ASSESSMENT_QUESTIONS.map((question) => (
          <fieldset key={question.key} className="m-0 flex flex-col gap-2 border-0 p-0">
            <legend className="mb-1 text-sm font-medium">
              {question.question} <span className="text-xs font-normal text-soft">{question.legalBasis}</span>
            </legend>
            <SegmentedControl
              size="sm"
              label={question.question}
              value={assessment[question.key].answer}
              onChange={(value) => setAnswer(question.key, { answer: value })}
              options={ANSWERS}
            />
            <Textarea
              aria-label={`Reason: ${question.question}`}
              placeholder="Why, in a sentence (optional)"
              rows={2}
              maxLength={MAX_REASON_CHARS}
              value={assessment[question.key].reason}
              onChange={(event) => setAnswer(question.key, { reason: event.target.value })}
            />
          </fieldset>
        ))}
        <div className="flex flex-col gap-2">
          <Label>Classification</Label>
          <SegmentedControl
            label="Classification"
            value={classification}
            onChange={setClassification}
            options={CLASSIFICATIONS.map((value) => ({ value, label: CLASSIFICATION_LABELS[value] }))}
          />
          <p className="m-0 text-xs text-muted-foreground">
            {suggestion === "undetermined"
              ? "The answers do not decide it yet."
              : `The answers suggest: ${CLASSIFICATION_LABELS[suggestion].toLowerCase()}.`}{" "}
            Who classified it and when is recorded in the audit log.
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Started at (your time zone)" htmlFor="assess-started">
            <Input id="assess-started" type="datetime-local" value={startedAt} onChange={(event) => setStartedAt(event.target.value)} />
          </Field>
          <Field label="Ended at" htmlFor="assess-ended" hint="Leave empty while it is still going on.">
            <Input id="assess-ended" type="datetime-local" value={endedAt} onChange={(event) => setEndedAt(event.target.value)} />
          </Field>
        </div>
        <Field label="Cause" htmlFor="assess-cause" hint="What caused it and what was done, as far as known.">
          <Textarea id="assess-cause" rows={4} maxLength={MAX_CAUSE_CHARS} value={cause} onChange={(event) => setCause(event.target.value)} />
        </Field>
        <ErrorBanner error={error} />
      </div>
    </AppDialog>
  );
}

/** Adds an entry people write to the incident's timeline. Needs no license. */
export function TimelineEntryDialog({ incident, onClose, onSaved }: { incident: IncidentView; onClose: () => void; onSaved: (incident: IncidentView) => void }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [at, setAt] = useState(() => toLocalInput(new Date().toISOString()));
  const [text, setText] = useState("");

  function save() {
    const iso = fromLocalInput(at);
    if (!iso || !text.trim()) {
      setError("Enter a time and what happened.");
      return;
    }
    // The server keeps the entries people added and drops collected ones sent back.
    const own = incident.timeline.filter((entry) => entry.source === "person").map(({ at: time, text: entryText }) => ({ at: time, text: entryText }));
    startTransition(async () => {
      try {
        onSaved(await callApi<IncidentView>(`/incidents/${incident.id}`, "PUT", { timeline: [...own, { at: iso, text: text.trim() }] }));
      } catch (err) {
        setError((err as Error).message);
      }
    });
  }

  return (
    <AppDialog open onClose={onClose} title="Add a timeline entry" maxWidth="md" submitLabel="Add" onSubmit={save} isSubmitting={pending}>
      <div className="flex flex-col gap-4">
        <Field label="When (your time zone)" htmlFor="timeline-at">
          <Input id="timeline-at" type="datetime-local" value={at} onChange={(event) => setAt(event.target.value)} />
        </Field>
        <Field label="What happened" htmlFor="timeline-text" hint="One line, e.g. who was told or what was changed.">
          <Input id="timeline-text" value={text} maxLength={MAX_TIMELINE_TEXT} onChange={(event) => setText(event.target.value)} />
        </Field>
        <ErrorBanner error={error} />
      </div>
    </AppDialog>
  );
}

/** Deletes an incident with its facts and drafts. Needs no license. */
export function ConfirmIncidentDelete({ incident, onClose, onDeleted }: { incident: IncidentView; onClose: () => void; onDeleted: () => void }) {
  const [pending, startTransition] = useTransition();
  function remove() {
    startTransition(async () => {
      try {
        await callApi(`/incidents/${incident.id}`, "DELETE");
        toast.success("Incident deleted");
        onDeleted();
      } catch (err) {
        toast.error((err as Error).message);
      }
    });
  }
  return (
    <AppDialog open onClose={onClose} title="Delete incident" submitLabel="Delete" onSubmit={remove} isSubmitting={pending}>
      <p className="text-sm">Delete “{incident.title}” with its timeline, assessment, facts and notification drafts? This cannot be undone.</p>
    </AppDialog>
  );
}
