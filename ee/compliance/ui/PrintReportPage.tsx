// SPDX-License-Identifier: Elastic-2.0
import { notFound } from "next/navigation";
import { requirePermission } from "@/src/lib/auth";
import { parseRouteId } from "@/ee/compliance/http";
import { getReport, REPORT_NOT_FOUND } from "@/ee/compliance/reports";
import PrintShell from "@/ee/compliance/ui/PrintShell";
import ReportDocumentView from "@/ee/compliance/ui/ReportDocumentView";

export const metadata = { title: "Compliance report (print)" };

/** A print-friendly page of a stored report, to print or save as PDF from the browser. */
export default async function ComplianceReportPrintPage({ params }: { params: Promise<{ id?: string }> }) {
  await requirePermission("compliance:read");
  const { id } = await params;
  let detail;
  try {
    detail = await getReport(parseRouteId(id, REPORT_NOT_FOUND));
  } catch {
    notFound();
  }
  return (
    <PrintShell backHref={`/compliance/reports/${detail.id}`}>
      <ReportDocumentView document={detail.document} sha256={detail.sha256} />
    </PrintShell>
  );
}
