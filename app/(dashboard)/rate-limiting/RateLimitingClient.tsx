"use client";

import { PageHeader } from "@/components/ui/PageHeader";
import { SectionCard } from "@/components/ui/SectionCard";
import { RateLimitSettingsFields } from "@/components/proxy-hosts/RateLimitFields";
import type { RateLimitSettings } from "@/lib/settings";
import { SettingsForm, SettingsGroupForms } from "@/src/components/settings/settings-form";
import { updateRateLimitSettingsAction } from "../settings/actions";
import { useUnsavedWarning } from "../settings/use-unsaved-warning";

export type RateLimitingProps = {
  rateLimit: RateLimitSettings | null;
  /** settings:write */
  canSave: boolean;
  /** waf:read, for the breadcrumb's link. */
  canOpenSecurity: boolean;
};

/** The rate limiting defaults for every proxy host. */
export default function RateLimitingClient({ rateLimit, canSave, canOpenSecurity }: RateLimitingProps) {
  const onDirtyChange = useUnsavedWarning();
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        className="mb-0"
        breadcrumb={["Observe", canOpenSecurity ? { label: "Security events", href: "/security" } : "Security events", "Rate limiting"]}
        title="Rate limiting"
        description="For every proxy host. A host can add its own rules or replace these."
      />
      <SettingsGroupForms name="Rate limiting" canSave={canSave} onDirtyChange={onDirtyChange}>
        <SectionCard title="Default rules" headingLevel={2} divided={false}>
          <SettingsForm action={updateRateLimitSettingsAction} className="border-t border-line px-5 py-4">
            <RateLimitSettingsFields value={rateLimit ?? null} />
          </SettingsForm>
        </SectionCard>
      </SettingsGroupForms>
    </div>
  );
}
