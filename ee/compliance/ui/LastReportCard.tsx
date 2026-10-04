// SPDX-License-Identifier: Elastic-2.0
"use client";

import Link from "next/link";
import { FileDown, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/EmptyState";
import { SectionCard } from "@/components/ui/SectionCard";
import { StatusDot } from "@/components/ui/StatusDot";
import { useFormat } from "@/components/preferences/PreferencesProvider";
import type { ReportScheduleView } from "../schedules";
import type { StoredReportSummary } from "../types";
import { FINDING_TEXT, findingParts, periodText } from "./format";
import { API_BASE } from "./shared";

/** A report as the overview shows it, with the result of its integrity check. */
export type ShownReport = StoredReportSummary & { integrity: { tone: "ok" | "warn" | "bad"; text: string } };

/** The newest evidence pack of a schedule, or the newest report made by hand. */
export type LastReportView = {
  kind: "pack" | "report";
  scheduleId: number | null;
  generatedAt: string;
  reports: ShownReport[];
};

function shortHash(sha256: string): string {
  return `${sha256.slice(0, 8)}…${sha256.slice(-8)}`;
}

function Findings({ report }: { report: StoredReportSummary }) {
  const parts = findingParts(report.findings);
  if (parts.length === 0) return <span className="text-soft">No findings</span>;
  return (
    <span className="flex flex-wrap gap-x-2.5">
      {parts.map((part) => (
        <span key={part.severity} className={FINDING_TEXT[part.severity]}>
          <span className="num">{part.count}</span> {part.severity}
        </span>
      ))}
    </span>
  );
}

function PdfLink({ report, label, variant }: { report: StoredReportSummary; label: string; variant: "secondary" | "ghost" }) {
  return (
    <Button asChild variant={variant} size="sm">
      <a href={`/print/compliance/reports/${report.id}`} target="_blank" rel="noopener" aria-label={`${label}: ${report.title}`}>
        <FileDown />
        {label}
      </a>
    </Button>
  );
}

function JsonLink({ report }: { report: StoredReportSummary }) {
  return (
    <Button asChild variant="ghost" size="sm">
      <a href={`${API_BASE}/reports/${report.id}/export?format=json`} aria-label={`JSON: ${report.title}`}>
        JSON
      </a>
    </Button>
  );
}

export default function LastReportCard({
  last,
  schedules,
  onOpenReports,
}: {
  last: LastReportView | null;
  schedules: ReportScheduleView[];
  onOpenReports: () => void;
}) {
  const format = useFormat();
  const allReports = (
    <Button variant="link" size="sm" className="h-auto px-0" onClick={onOpenReports}>
      All reports
    </Button>
  );

  if (!last || last.reports.length === 0) {
    return (
      <SectionCard title="Last report" divided={false} actions={allReports} className="flex min-w-0 flex-[1.7_1_480px] flex-col" contentClassName="px-5 pb-[18px]">
        <EmptyState
          compact
          icon={FileText}
          className="px-0 py-1"
          title="No report yet"
          description="Generated reports are stored with their SHA-256 and recorded in the audit log, as evidence for the controls they support."
        />
      </SectionCard>
    );
  }

  const first = last.reports[0];
  const schedule = last.scheduleId !== null ? schedules.find((item) => item.id === last.scheduleId) ?? null : null;
  const heading = last.kind === "pack" ? `${schedule?.name ?? "Evidence pack"}, ${periodText(first.period)}` : first.title;
  const by = first.generatedBy.userId === null ? "by the schedule" : `by ${first.generatedBy.name ?? `user ${first.generatedBy.userId}`}`;
  const integrityTone = last.reports.every((report) => report.integrity.tone === "ok")
    ? "ok"
    : last.reports.some((report) => report.integrity.tone === "bad")
      ? "bad"
      : "warn";

  return (
    <SectionCard title="Last report" divided={false} actions={allReports} className="flex min-w-0 flex-[1.7_1_480px] flex-col" contentClassName="flex flex-col gap-3 px-5 pb-[18px]">
      <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
        <span className="flex min-w-0 flex-[1_1_240px] flex-col gap-0.5">
          <span className="text-base leading-6 font-semibold [overflow-wrap:anywhere]">
            {last.kind === "report" ? (
              <Link href={`/compliance/reports/${first.id}`} className="text-foreground underline-offset-4 hover:underline">
                {heading}
              </Link>
            ) : (
              heading
            )}
          </span>
          <span className="text-[13px] text-muted-foreground">
            {last.kind === "report" && `${periodText(first.period)} · `}generated <span className="num">{format.dateTime(last.generatedAt)}</span> {by}
          </span>
        </span>
        {last.kind === "report" && (
          <span className="flex gap-2">
            <PdfLink report={first} label="Download PDF" variant="secondary" />
            <JsonLink report={first} />
          </span>
        )}
      </div>

      {last.kind === "pack" ? (
        <ul className="m-0 flex list-none flex-col border-t border-line p-0">
          {last.reports.map((report) => (
            <li key={report.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line py-1.5 text-[13px]">
              <Link href={`/compliance/reports/${report.id}`} className="min-w-0 flex-1 text-foreground underline-offset-4 hover:underline">
                {report.title}
              </Link>
              <Findings report={report} />
              <span className="flex gap-1">
                <PdfLink report={report} label="PDF" variant="ghost" />
                <JsonLink report={report} />
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="flex items-center gap-2.5 border-y border-line py-2 text-[13px]">
          <span className="flex-1">Findings</span>
          <Findings report={first} />
        </div>
      )}

      <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-muted-foreground">
        <StatusDot tone={integrityTone} label={integrityTone === "ok" ? "Intact, matches its audit event" : last.reports.find((report) => report.integrity.tone !== "ok")?.integrity.text} />
        {last.reports.map((report) => (
          <span key={report.id} className="num text-soft" title={report.sha256}>
            SHA-256 {shortHash(report.sha256)}
          </span>
        ))}
      </span>
    </SectionCard>
  );
}
