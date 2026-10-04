// SPDX-License-Identifier: Elastic-2.0
import { notFound } from "next/navigation";
import { requirePermission } from "@/src/lib/auth";
import { can } from "@/src/lib/permissions";
import { parseRouteId } from "@/ee/compliance/http";
import { getReport, REPORT_NOT_FOUND } from "@/ee/compliance/reports";
import ReportDetailClient from "@/ee/compliance/ui/ReportDetailClient";

export const metadata = { title: "Compliance report" };

export default async function ComplianceReportPage({ params }: { params: Promise<{ id?: string }> }) {
  const { access } = await requirePermission("compliance:read");
  const { id } = await params;
  let detail;
  try {
    detail = await getReport(parseRouteId(id, REPORT_NOT_FOUND));
  } catch {
    notFound();
  }
  return <ReportDetailClient detail={detail} canWrite={can(access, "compliance:write")} />;
}
