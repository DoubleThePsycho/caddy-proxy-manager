// SPDX-License-Identifier: Elastic-2.0
import { PageHeader } from "@/components/ui/PageHeader";
import { SectionCard } from "@/components/ui/SectionCard";
import { requirePermission } from "@/src/lib/auth";
import { can } from "@/src/lib/permissions";
import { RestrictedNotice } from "@/src/components/settings/RestrictedNotice";
import { EDITION_LABELS, FEATURE_INFO } from "@/ee/licensing/features";
import { getClusterView } from "@/ee/high-availability/cluster/view";
import { getSharedStateView } from "@/ee/high-availability/shared-state/service";
import ClusterSection from "./ClusterSection";
import SharedStateSection from "./SharedStateSection";
import { removeSharedStateAction, saveSharedStateAction, sharedStateStatusAction } from "./shared-state-actions";

export const metadata = { title: "High availability" };

/**
 * The dashboard cluster (read-only: environment variables) and the shared
 * request-path state. Certificate storage is on Certificate settings.
 */
export default async function HighAvailabilityPage() {
  const { access } = await requirePermission("settings:read");
  // High availability is its own permission area, as on the REST API.
  const canRead = can(access, "high_availability:read");
  const [cluster, sharedState] = canRead ? await Promise.all([getClusterView(), getSharedStateView()]) : [null, null];
  const editionLabel = EDITION_LABELS[FEATURE_INFO.high_availability.edition];

  return (
    <div className="flex flex-col gap-5">
      <PageHeader className="mb-0" breadcrumb={["Platform", "High availability"]} title="High availability" />
      {cluster && sharedState ? (
        <>
          <ClusterSection view={cluster} editionLabel={editionLabel} />
          <SharedStateSection
            view={sharedState}
            canWrite={can(access, "high_availability:write")}
            editionLabel={editionLabel}
            save={saveSharedStateAction}
            remove={removeSharedStateAction}
            loadStatus={sharedStateStatusAction}
          />
        </>
      ) : (
        <SectionCard title="Dashboard cluster" headingLevel={2} padded>
          <RestrictedNotice permission="high_availability:read" />
        </SectionCard>
      )}
    </div>
  );
}
