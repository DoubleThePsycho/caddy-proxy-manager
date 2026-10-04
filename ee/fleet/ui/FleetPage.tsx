// SPDX-License-Identifier: Elastic-2.0
import { requirePermission } from "@/src/lib/auth";
import { can } from "@/src/lib/permissions";
import { EDITION_LABELS, FEATURE_INFO } from "@/ee/licensing/features";
import { isFeatureConfigurable } from "@/ee/licensing/store";
import { getFleetOverview } from "@/ee/fleet/overview";
import { FEATURE } from "@/ee/fleet/types";
import FleetClient from "./FleetClient";

export const metadata = { title: "Fleet" };

export default async function FleetPage() {
  const { access } = await requirePermission("fleet:read");
  // The overview carries no secrets: revisions are listed without content.
  const [overview, configurable] = await Promise.all([getFleetOverview(), isFeatureConfigurable(FEATURE)]);
  return (
    <FleetClient
      overview={overview}
      now={new Date().toISOString()}
      configurable={configurable}
      editionLabel={EDITION_LABELS[FEATURE_INFO[FEATURE].edition]}
      allowed={{ write: can(access, "fleet:write"), promote: can(access, "fleet:promote"), replicas: can(access, "fleet:replicas") }}
    />
  );
}
