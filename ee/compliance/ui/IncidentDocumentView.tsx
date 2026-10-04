// SPDX-License-Identifier: Elastic-2.0
/**
 * An incident as a document, for the print view: the register entry (window,
 * assessment, classification, cause, timeline) and the notification drafts.
 * No client hooks and no theme-dependent colours.
 */
import { controlsFor } from "../controls";
import { ASSESSMENT_QUESTIONS, CLASSIFICATION_LABELS, NOTIFICATION_STATUS_LABELS } from "../incident-register";
import { INCIDENT_STAGES } from "../incident-stages";
import type { IncidentView } from "../types";
import IncidentFactsView from "./IncidentFactsView";

function when(iso: string | null): string {
  return iso ? `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC` : "—";
}

const STATUS_TEXT = { submitted: "submitted", overdue: "overdue", open: "open" } as const;
const ANSWER_TEXT = { yes: "Yes", no: "No", unknown: "Not known yet" } as const;

export default function IncidentDocumentView({ incident, productName }: { incident: IncidentView; productName: string }) {
  return (
    <article className="space-y-6 text-sm text-foreground">
      <header className="space-y-2 border-b border-border pb-4">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">{productName} · NIS2 incident record and notification drafts</p>
        <h1 className="text-2xl font-bold tracking-tight">{incident.title}</h1>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
          <div className="flex gap-2">
            <dt className="text-muted-foreground">Became aware</dt>
            <dd>{when(incident.detectedAt)}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="text-muted-foreground">Status</dt>
            <dd>{incident.status}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="text-muted-foreground">Draft</dt>
            <dd>
              #{incident.id}, created {when(incident.createdAt)} by {incident.createdBy.name ?? `user ${incident.createdBy.userId ?? "?"}`}, last changed{" "}
              {when(incident.updatedAt)}
            </dd>
          </div>
        </dl>
      </header>

      <p className="rounded-md border border-border bg-muted/40 p-3 text-xs">
        A draft prepared with {productName}; it has not been sent to anyone. The person responsible submits each stage through the CSIRT&apos;s or
        competent authority&apos;s channel (in Italy, CSIRT Italia at ACN). Text marked as AI-generated was written by a language model from
        aggregated figures and must be checked.
      </p>

      <section className="space-y-2 break-inside-avoid-page">
        <h2 className="text-base font-semibold">Register entry</h2>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
          <div className="flex gap-2">
            <dt className="text-muted-foreground">Window</dt>
            <dd>
              {when(incident.startedAt)} to {incident.endedAt ? when(incident.endedAt) : incident.startedAt ? "ongoing" : "—"}
            </dd>
          </div>
          <div className="flex gap-2">
            <dt className="text-muted-foreground">Classification</dt>
            <dd>
              {CLASSIFICATION_LABELS[incident.classification]}
              {incident.classifiedAt
                ? `, by ${incident.classifiedBy?.name ?? `user ${incident.classifiedBy?.userId ?? "?"}`} on ${when(incident.classifiedAt)}`
                : ""}
            </dd>
          </div>
          <div className="flex gap-2">
            <dt className="text-muted-foreground">Notification</dt>
            <dd>{NOTIFICATION_STATUS_LABELS[incident.notification]}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="text-muted-foreground">Closed</dt>
            <dd>{when(incident.closedAt)}</dd>
          </div>
        </dl>
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr>
              <th className="border border-border bg-muted/50 px-2 py-1 text-left font-semibold">Significance question</th>
              <th className="border border-border bg-muted/50 px-2 py-1 text-left font-semibold">Legal basis</th>
              <th className="border border-border bg-muted/50 px-2 py-1 text-left font-semibold">Answer</th>
              <th className="border border-border bg-muted/50 px-2 py-1 text-left font-semibold">Reason</th>
            </tr>
          </thead>
          <tbody>
            {ASSESSMENT_QUESTIONS.map((question) => (
              <tr key={question.key}>
                <td className="border border-border px-2 py-1">{question.question}</td>
                <td className="border border-border px-2 py-1">{question.legalBasis}</td>
                <td className="border border-border px-2 py-1">{ANSWER_TEXT[incident.assessment[question.key].answer]}</td>
                <td className="border border-border px-2 py-1 whitespace-pre-wrap [overflow-wrap:anywhere]">{incident.assessment[question.key].reason || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="space-y-1">
          <p className="text-xs font-semibold text-muted-foreground">Cause</p>
          <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{incident.cause || "—"}</p>
        </div>
        {incident.timeline.length > 0 && (
          <div className="space-y-1">
            <p className="text-xs font-semibold text-muted-foreground">Timeline</p>
            <ul className="space-y-0.5 text-xs">
              {incident.timeline.map((entry, index) => (
                <li key={`${entry.at}-${index}`} className="[overflow-wrap:anywhere]">
                  {when(entry.at)}: {entry.text}
                  {entry.source === "facts" ? " (collected)" : ""}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <section className="space-y-2 break-inside-avoid-page">
        <h2 className="text-base font-semibold">Deadlines</h2>
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr>
              <th className="border border-border bg-muted/50 px-2 py-1 text-left font-semibold">Stage</th>
              <th className="border border-border bg-muted/50 px-2 py-1 text-left font-semibold">Legal basis</th>
              <th className="border border-border bg-muted/50 px-2 py-1 text-left font-semibold">Deadline</th>
              <th className="border border-border bg-muted/50 px-2 py-1 text-left font-semibold">Status</th>
              <th className="border border-border bg-muted/50 px-2 py-1 text-left font-semibold">Submitted</th>
              <th className="border border-border bg-muted/50 px-2 py-1 text-left font-semibold">Reference</th>
            </tr>
          </thead>
          <tbody>
            {incident.stages.map((stage) => (
              <tr key={stage.key}>
                <td className="border border-border px-2 py-1">{stage.label}</td>
                <td className="border border-border px-2 py-1">{stage.legalBasis}</td>
                <td className="border border-border px-2 py-1">
                  {when(stage.deadline)}
                  <div className="text-muted-foreground">{stage.deadlineRule}</div>
                </td>
                <td className="border border-border px-2 py-1">{STATUS_TEXT[stage.status]}</td>
                <td className="border border-border px-2 py-1">{when(stage.submittedAt)}</td>
                <td className="border border-border px-2 py-1">{stage.reference ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {INCIDENT_STAGES.map((definition) => {
        const stage = incident.stages.find((item) => item.key === definition.key)!;
        return (
          <section key={definition.key} className="space-y-3">
            <h2 className="text-base font-semibold">
              {definition.label} <span className="text-xs font-normal text-muted-foreground">({definition.legalBasis})</span>
            </h2>
            {stage.ai && (
              <p className="text-xs font-semibold">
                AI-generated first draft ({stage.ai.provider}, {stage.ai.model}, {when(stage.ai.generatedAt)})
                {stage.editedAt ? `, edited by a person on ${when(stage.editedAt)}` : ", not edited since"}.
              </p>
            )}
            {definition.fields.map((field) => (
              <div key={field.key} className="space-y-1 break-inside-avoid">
                <p className="text-xs font-semibold text-muted-foreground">{field.label}</p>
                <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{stage.fields[field.key] || "—"}</p>
              </div>
            ))}
          </section>
        );
      })}

      {incident.facts && (
        <section className="space-y-2 break-inside-avoid-page">
          <h2 className="text-base font-semibold">Facts collected</h2>
          <IncidentFactsView facts={incident.facts} />
        </section>
      )}

      <section className="space-y-2 break-inside-avoid-page">
        <h2 className="text-base font-semibold">Controls this record supports</h2>
        <ul className="list-disc space-y-1 pl-5 text-xs">
          {controlsFor("incident_notification").map((control) => (
            <li key={`${control.framework}-${control.ref}`}>
              {control.framework} {control.ref} {control.title}: {control.how}
            </li>
          ))}
        </ul>
      </section>
    </article>
  );
}
