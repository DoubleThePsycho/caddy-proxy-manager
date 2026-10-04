// SPDX-License-Identifier: Elastic-2.0
import { notFound } from "next/navigation";
import { requirePermission } from "@/src/lib/auth";
import { can } from "@/src/lib/permissions";
import { EDITION_LABELS, FEATURE_INFO } from "@/ee/licensing/features";
import { isFeatureConfigurable } from "@/ee/licensing/store";
import { getAiSettingsView } from "@/ee/ai/settings";
import { parseRouteId } from "@/ee/compliance/http";
import { getIncident, INCIDENT_NOT_FOUND, listProxyHostChoices } from "@/ee/compliance/incidents";
import { FEATURE } from "@/ee/compliance/types";
import IncidentEditor from "@/ee/compliance/ui/IncidentEditor";

export const metadata = { title: "Incident notification draft" };

export default async function ComplianceIncidentPage({ params }: { params: Promise<{ id?: string }> }) {
  const { access } = await requirePermission("compliance:read");
  const { id } = await params;
  let incident;
  try {
    incident = await getIncident(parseRouteId(id, INCIDENT_NOT_FOUND));
  } catch {
    notFound();
  }
  // Only whether an AI provider is configured; its settings and key stay on the server.
  const [configurable, ai] = await Promise.all([isFeatureConfigurable(FEATURE), getAiSettingsView()]);
  return (
    <IncidentEditor
      initial={incident}
      proxyHosts={await listProxyHostChoices()}
      canWrite={can(access, "compliance:write")}
      configurable={configurable}
      aiConfigured={ai.configured}
      editionLabel={EDITION_LABELS[FEATURE_INFO[FEATURE].edition]}
    />
  );
}
