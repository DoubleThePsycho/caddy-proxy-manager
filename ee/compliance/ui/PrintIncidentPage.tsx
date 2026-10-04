// SPDX-License-Identifier: Elastic-2.0
import { notFound } from "next/navigation";
import { requirePermission } from "@/src/lib/auth";
import { BRAND_NAME } from "@/src/lib/brand";
import { parseRouteId } from "@/ee/compliance/http";
import { getIncident, INCIDENT_NOT_FOUND } from "@/ee/compliance/incidents";
import PrintShell from "@/ee/compliance/ui/PrintShell";
import IncidentDocumentView from "@/ee/compliance/ui/IncidentDocumentView";

export const metadata = { title: "Incident notification draft (print)" };

/** A print-friendly page of an incident notification draft. */
export default async function ComplianceIncidentPrintPage({ params }: { params: Promise<{ id?: string }> }) {
  await requirePermission("compliance:read");
  const { id } = await params;
  let incident;
  try {
    incident = await getIncident(parseRouteId(id, INCIDENT_NOT_FOUND));
  } catch {
    notFound();
  }
  return (
    <PrintShell backHref={`/compliance/incidents/${incident.id}`}>
      <IncidentDocumentView incident={incident} productName={BRAND_NAME} />
    </PrintShell>
  );
}
