import { PageHeader } from "@/components/ui/PageHeader";
import { SectionCard } from "@/components/ui/SectionCard";
import { requirePermission } from "@/src/lib/auth";
import { can } from "@/src/lib/permissions";
import { config } from "@/src/lib/config";
import { listOAuthProviders } from "@/src/lib/models/oauth-providers";
import { RestrictedNotice } from "@/src/components/settings/RestrictedNotice";
import OAuthProvidersSection from "./OAuthProvidersSection";

export const metadata = { title: "OAuth providers" };

/** OpenID Connect and OAuth providers for dashboard sign-in. */
export default async function OAuthProvidersPage() {
  const { access } = await requirePermission("settings:read");
  // The providers are their own permission area, as on the REST API.
  const canRead = can(access, "sso:read");
  const providers = canRead ? await listOAuthProviders() : [];
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        className="mb-0"
        breadcrumb={["Users and sign-in", canRead ? { label: "Sign-in and directories", href: "/sign-in" } : "Sign-in and directories", "OAuth providers"]}
        title="OAuth providers"
      />
      {canRead ? (
        <OAuthProvidersSection initialProviders={providers} baseUrl={config.baseUrl} />
      ) : (
        <SectionCard title="Providers" headingLevel={2} padded>
          <RestrictedNotice permission="sso:read" />
        </SectionCard>
      )}
    </div>
  );
}
