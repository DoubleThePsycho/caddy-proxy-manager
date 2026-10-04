// SPDX-License-Identifier: Elastic-2.0
"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { ChevronLeft, ChevronRight, FileDown, FileText, Plus, Printer, Trash2 } from "lucide-react";
import { AppDialog } from "@/components/ui/AppDialog";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/EmptyState";
import { SectionCard } from "@/components/ui/SectionCard";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useFormat } from "@/components/preferences/PreferencesProvider";
import type { ReportScheduleView } from "../schedules";
import type { ReportListPage, StoredReportSummary } from "../types";
import type { ChannelChoice, QuestionChoice } from "./ComplianceClient";
import { FINDING_TEXT, findingParts, periodText } from "./format";
import SchedulesSection from "./SchedulesSection";
import { API_BASE, callApi, LOCKED_HINT } from "./shared";

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

/** Stored reports, newest first, and the schedules that generate them. */
export default function ReportsTab({
  initial,
  schedules,
  channels,
  questions,
  canWrite,
  configurable,
  now,
  onGenerate,
}: {
  initial: ReportListPage;
  schedules: ReportScheduleView[];
  channels: ChannelChoice[];
  /** Saved analytics questions a schedule can include. */
  questions: QuestionChoice[];
  canWrite: boolean;
  configurable: boolean;
  now: number;
  onGenerate: () => void;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const format = useFormat();
  const [pending, startTransition] = useTransition();
  const [confirmDelete, setConfirmDelete] = useState<StoredReportSummary | null>(null);
  const pages = Math.max(1, Math.ceil(initial.total / initial.perPage));
  const scheduleNames = new Map(schedules.map((schedule) => [schedule.id, schedule.name]));

  function pageHref(page: number): string {
    const params = new URLSearchParams(searchParams?.toString() ?? "");
    params.set("tab", "reports");
    if (page > 1) params.set("page", String(page));
    else params.delete("page");
    return `${pathname}?${params.toString()}`;
  }

  function remove() {
    const report = confirmDelete;
    if (!report) return;
    startTransition(async () => {
      try {
        await callApi(`/reports/${report.id}`, "DELETE");
        toast.success("Report deleted");
      } catch (err) {
        toast.error((err as Error).message);
      }
      setConfirmDelete(null);
      router.refresh();
    });
  }

  return (
    <>
      <SectionCard
        title="Reports"
        count={initial.total}
        description="Each report is stored as canonical JSON with its SHA-256, recorded in the audit log when it was generated."
      >
        {initial.reports.length === 0 ? (
          <EmptyState
            compact
            icon={FileText}
            title="No reports yet"
            description="Generated reports are stored here with their SHA-256 until you delete them."
            action={
              canWrite ? (
                <Button variant="secondary" size="sm" onClick={onGenerate} disabled={!configurable} title={configurable ? undefined : LOCKED_HINT}>
                  <Plus />
                  Generate a report
                </Button>
              ) : undefined
            }
          />
        ) : (
          <Table className="min-w-[960px]">
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Report</TableHead>
                <TableHead scope="col">Period (UTC)</TableHead>
                <TableHead scope="col">Generated</TableHead>
                <TableHead scope="col">Findings</TableHead>
                <TableHead scope="col">SHA-256</TableHead>
                <TableHead scope="col" className="w-[120px]">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {initial.reports.map((report) => (
                <TableRow key={report.id}>
                  <TableCell>
                    <Link href={`/compliance/reports/${report.id}`} className="font-medium text-foreground underline-offset-4 hover:underline">
                      {report.title}
                    </Link>
                  </TableCell>
                  <TableCell className="whitespace-nowrap">{periodText(report.period)}</TableCell>
                  <TableCell>
                    <span className="flex flex-col gap-0.5">
                      <span className="num whitespace-nowrap">{format.dateTime(report.generatedAt)}</span>
                      <span className="text-xs text-soft">
                        {report.scheduleId !== null
                          ? `Schedule ${scheduleNames.has(report.scheduleId) ? `“${scheduleNames.get(report.scheduleId)}”` : `#${report.scheduleId}`}`
                          : report.generatedBy.name ?? `User #${report.generatedBy.userId ?? "?"}`}
                      </span>
                    </span>
                  </TableCell>
                  <TableCell>
                    <Findings report={report} />
                  </TableCell>
                  <TableCell>
                    <span className="num text-xs text-muted-foreground" title={report.sha256}>
                      {report.sha256.slice(0, 16)}…
                    </span>
                  </TableCell>
                  <TableCell>
                    <span className="flex justify-end gap-0.5">
                      <Button asChild size="icon-sm" variant="ghost" title="Download JSON">
                        <a href={`${API_BASE}/reports/${report.id}/export?format=json`} aria-label={`Download ${report.title} as JSON`}>
                          <FileDown />
                        </a>
                      </Button>
                      <Button asChild size="icon-sm" variant="ghost" title="Print view">
                        <a href={`/print/compliance/reports/${report.id}`} target="_blank" rel="noopener" aria-label={`Print ${report.title}`}>
                          <Printer />
                        </a>
                      </Button>
                      {canWrite && (
                        <Button size="icon-sm" variant="ghost" title="Delete" aria-label={`Delete ${report.title}`} onClick={() => setConfirmDelete(report)}>
                          <Trash2 />
                        </Button>
                      )}
                    </span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {pages > 1 && (
          <div className="flex items-center justify-center gap-2 border-t border-line px-4 py-2.5">
            <Button asChild={initial.page > 1} variant="outline" size="icon-sm" disabled={initial.page <= 1} aria-label="Newer reports">
              {initial.page > 1 ? (
                <Link href={pageHref(initial.page - 1)}>
                  <ChevronLeft />
                </Link>
              ) : (
                <ChevronLeft />
              )}
            </Button>
            <span className="text-[13px] text-muted-foreground">
              Page <span className="num">{initial.page}</span> of <span className="num">{pages}</span>
            </span>
            <Button asChild={initial.page < pages} variant="outline" size="icon-sm" disabled={initial.page >= pages} aria-label="Older reports">
              {initial.page < pages ? (
                <Link href={pageHref(initial.page + 1)}>
                  <ChevronRight />
                </Link>
              ) : (
                <ChevronRight />
              )}
            </Button>
          </div>
        )}
      </SectionCard>

      <SchedulesSection schedules={schedules} channels={channels} questions={questions} canWrite={canWrite} configurable={configurable} now={now} />

      <AppDialog open={confirmDelete !== null} onClose={() => setConfirmDelete(null)} title="Delete report" submitLabel="Delete" onSubmit={remove} isSubmitting={pending}>
        <p className="text-sm">
          Delete the {confirmDelete?.title.toLowerCase()} for {confirmDelete ? periodText(confirmDelete.period) : ""}? Copies you downloaded can still be
          checked against the SHA-256 recorded in the audit log.
        </p>
      </AppDialog>
    </>
  );
}
