// SPDX-License-Identifier: Elastic-2.0
import { requirePermission } from "@/src/lib/auth";
import { can } from "@/src/lib/permissions";
import { EDITION_LABELS, FEATURE_INFO } from "@/ee/licensing/features";
import { isFeatureConfigurable } from "@/ee/licensing/store";
import { SAML_FEATURE } from "@/ee/saml/constants";
import { listProviders } from "@/ee/saml/providers";
import { baseUrlIsSecureContext } from "@/ee/saml/store";
import SamlClient from "@/ee/saml/ui/SamlClient";

export const metadata = { title: "SAML" };

export default async function SamlPage() {
  const session = await requirePermission("sso:read");
  return (
    <SamlClient
      providers={await listProviders()}
      configurable={await isFeatureConfigurable(SAML_FEATURE)}
      canWrite={can(session.access, "sso:write")}
      secureBaseUrl={baseUrlIsSecureContext()}
      editionLabel={EDITION_LABELS[FEATURE_INFO[SAML_FEATURE].edition]}
    />
  );
}
