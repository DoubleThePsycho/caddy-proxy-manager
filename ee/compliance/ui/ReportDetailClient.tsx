// SPDX-License-Identifier: Elastic-2.0
"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { FileDown, Printer, Trash2 } from "lucide-react";
import { AppDialog } from "@/components/ui/AppDialog";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/PageHeader";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { StoredReportDetail } from "../types";
import { periodText } from "./format";
import ReportDocumentView from "./ReportDocumentView";
import { API_BASE, callApi } from "./shared";

function Integrity({ detail }: { detail: StoredReportDetail }) {
  const { integrity } = detail;
  const ok = integrity.contentMatches && integrity.auditEvent?.sha256Matches !== false;
  return (
    <Banner
      tone={ok ? "ok" : "bad"}
      layout="stacked"
      title={
        `${integrity.contentMatches ? "The stored report matches its SHA-256." : "The stored report no longer matches its SHA-256."} ` +
        (integrity.auditEvent
          ? integrity.auditEvent.sha256Matches
            ? `The audit log recorded the same SHA-256 at generation (event #${integrity.auditEvent.id}).`
            : `The SHA-256 recorded in the audit log (event #${integrity.auditEvent.id}) is different.`
          : "No audit event of its generation was found (it may have been removed by audit retention).")
      }
    >
      <p className="m-0 text-xs">
        To check a downloaded JSON copy: remove its &quot;integrity&quot; member, canonicalize it with RFC 8785 (JSON Canonicalization Scheme) and compare
        its SHA-256 with <span className="num break-all text-foreground">{integrity.sha256}</span>.
      </p>
    </Banner>
  );
}

export default function ReportDetailClient({ detail, canWrite }: { detail: StoredReportDetail; canWrite: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [section, setSection] = useState(detail.document.sections[0]?.key ?? "summary");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const csvChoices = [
    { key: "summary", title: "Summary and metadata" },
    { key: "findings", title: "Findings" },
    ...detail.document.sections.map((item) => ({ key: item.key, title: item.title })),
  ];

  function remove() {
    startTransition(async () => {
      try {
        await callApi(`/reports/${detail.id}`, "DELETE");
        toast.success("Report deleted");
        router.push("/compliance?tab=reports");
      } catch (err) {
        toast.error((err as Error).message);
        setConfirmDelete(false);
      }
    });
  }

  return (
    <div className="flex w-full min-w-0 flex-col gap-5">
      <PageHeader
        className="mb-0"
        breadcrumb={["Govern", { label: "Compliance", href: "/compliance" }, { label: "Reports", href: "/compliance?tab=reports" }, `#${detail.id}`]}
        title={detail.document.title}
        description={`${periodText(detail.period)} (UTC)`}
        actions={
          <>
            <Button asChild variant="outline">
              <a href={`${API_BASE}/reports/${detail.id}/export?format=json`}>
                <FileDown /> JSON
              </a>
            </Button>
            <span className="flex items-center gap-1">
              <Select value={section} onValueChange={setSection}>
                <SelectTrigger className="h-9 w-56" aria-label="CSV table">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {csvChoices.map((choice) => (
                    <SelectItem key={choice.key} value={choice.key}>
                      {choice.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button asChild variant="outline">
                <a href={`${API_BASE}/reports/${detail.id}/export?format=csv&section=${encodeURIComponent(section)}`}>
                  <FileDown /> CSV
                </a>
              </Button>
            </span>
            <Button asChild variant="outline">
              <a href={`/print/compliance/reports/${detail.id}`} target="_blank" rel="noopener">
                <Printer /> Print / PDF
              </a>
            </Button>
            {canWrite && (
              <Button variant="danger" onClick={() => setConfirmDelete(true)}>
                <Trash2 /> Delete
              </Button>
            )}
          </>
        }
      />

      <Integrity detail={detail} />

      <div className="min-w-0 overflow-x-auto rounded-2xl border border-line bg-panel p-4 md:p-6">
        <ReportDocumentView document={detail.document} sha256={detail.sha256} />
      </div>

      <AppDialog open={confirmDelete} onClose={() => setConfirmDelete(false)} title="Delete report" submitLabel="Delete" onSubmit={remove} isSubmitting={pending}>
        <p className="text-sm">Delete this report? Copies you downloaded can still be checked against the SHA-256 recorded in the audit log.</p>
      </AppDialog>
    </div>
  );
}
