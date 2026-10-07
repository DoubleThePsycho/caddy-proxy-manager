// SPDX-License-Identifier: Elastic-2.0
import { requirePermission } from "@/src/lib/auth";
import { can } from "@/src/lib/permissions";
import { listProviders } from "@/ee/saml/providers";
import { baseUrlIsSecureContext } from "@/ee/saml/store";
import SamlClient from "@/ee/saml/ui/SamlClient";

export const metadata = { title: "SAML" };

export default async function SamlPage() {
  const session = await requirePermission("sso:read");
  return (
    <SamlClient
      providers={await listProviders()}
      canWrite={can(session.access, "sso:write")}
      secureBaseUrl={baseUrlIsSecureContext()}
    />
  );
}
