// SPDX-License-Identifier: Elastic-2.0
import { requirePermission } from "@/src/lib/auth";
import { can } from "@/src/lib/permissions";
import { APP_VERSION } from "@/src/lib/app-version";
import { countManagedNodes, getLicenseState } from "@/ee/licensing/store";
import { getTrustedLicenseKeys } from "@/ee/licensing/public-keys";
import { getFeatureUsage } from "@/ee/licensing/usage";
import { toLicenseView } from "@/ee/licensing/view";
import { getLicenseAutoUpdateView } from "@/ee/licensing/auto-update";
import LicenseClient from "./LicenseClient";

export const metadata = { title: "License" };

export default async function LicensePage() {
  const { access } = await requirePermission("license:read");
  const [state, nodes, usage, autoUpdate] = await Promise.all([
    getLicenseState(),
    countManagedNodes(),
    getFeatureUsage(access),
    getLicenseAutoUpdateView(),
  ]);
  return (
    <LicenseClient
      license={toLicenseView(state, nodes)}
      usage={usage}
      version={APP_VERSION}
      trustedKeyIds={[...getTrustedLicenseKeys().keys()]}
      canWrite={can(access, "license:write")}
      now={new Date().toISOString()}
      autoUpdate={autoUpdate}
    />
  );
}
