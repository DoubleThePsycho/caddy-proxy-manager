"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/PageHeader";
import { SectionCard } from "@/components/ui/SectionCard";
import type { GeneralSettings } from "@/lib/settings";
import type { UsagePingView } from "@/src/lib/usage-ping/store";
import { settingsSectionHref } from "@/src/lib/settings-sections";
import { OverrideRow, SettingRow, SettingRows, SettingsForm, SettingsGroupForms } from "@/src/components/settings/settings-form";
import { updateGeneralSettingsAction } from "./actions";
import UsagePingSection from "./UsagePingSection";
import { useUnsavedWarning } from "./use-unsaved-warning";

export type SettingsClientProps = {
  general: GeneralSettings | null;
  /** BASE_URL, read-only. */
  baseUrl: string;
  usagePing: UsagePingView;
  isSlave: boolean;
  /** On a replica: whether it overrides the master's general settings. */
  overrideGeneral: boolean;
  /** settings:write */
  canWriteSettings: boolean;
};

/**
 * Old links to a section of this page (`/settings#dns-providers`) go to the
 * page that holds it now; `?section=` is redirected by the server.
 */
function useMovedSectionRedirect() {
  const router = useRouter();
  useEffect(() => {
    const id = decodeURIComponent(window.location.hash.slice(1));
    const href = id ? settingsSectionHref(id) : null;
    if (href && !href.startsWith("/settings#") && href !== "/settings") router.replace(href);
  }, [router]);
}

/** The settings of the install itself: the primary domain, the dashboard address and the usage ping. */
export default function SettingsClient({ general, baseUrl, usagePing, isSlave, overrideGeneral, canWriteSettings }: SettingsClientProps) {
  useMovedSectionRedirect();
  const onDirtyChange = useUnsavedWarning();
  return (
    <div className="flex flex-col gap-5">
      <PageHeader className="mb-0" title="Settings" />
      <SettingsGroupForms name="General" canSave={canWriteSettings} onDirtyChange={onDirtyChange}>
        <GeneralCard general={general} baseUrl={baseUrl} isSlave={isSlave} override={overrideGeneral} />
      </SettingsGroupForms>
      <section id="usage-ping" aria-labelledby="usage-ping-heading" className="flex scroll-mt-20 md:scroll-mt-4 flex-col gap-3">
        <h2 id="usage-ping-heading" className="m-0 text-lg leading-[26px] font-semibold">
          Usage ping
        </h2>
        <UsagePingSection initial={usagePing} canWrite={canWriteSettings} />
      </section>
    </div>
  );
}

function GeneralCard({ general, baseUrl, isSlave, override: initialOverride }: { general: GeneralSettings | null; baseUrl: string; isSlave: boolean; override: boolean }) {
  const [override, setOverride] = useState(initialOverride);
  const disabled = isSlave && !override;
  return (
    <SectionCard id="general" className="scroll-mt-20 md:scroll-mt-4" title="General" headingLevel={2} divided={false}>
      <SettingsForm action={updateGeneralSettingsAction}>
        <SettingRows>
          {isSlave && <OverrideRow id="general-override" checked={override} onCheckedChange={setOverride} />}
          <SettingRow label="Primary domain" htmlFor="settings-primary-domain" hint="Suggested when you create a proxy host.">
            <Input
              id="settings-primary-domain"
              name="primaryDomain"
              defaultValue={general?.primaryDomain ?? "ingressi.localhost"}
              required
              disabled={disabled}
              className="num w-[320px] max-w-full"
            />
          </SettingRow>
          {/* The contact e-mail is edited under Certificate settings; the action saves both. */}
          <input type="hidden" name="acmeEmail" value={general?.acmeEmail ?? ""} data-untracked="" />
          <SettingRow label="Dashboard address" note="Set by BASE_URL in the environment.">
            <span className="num flex min-h-9 items-center text-[13px] [overflow-wrap:anywhere]">{baseUrl}</span>
          </SettingRow>
        </SettingRows>
      </SettingsForm>
    </SectionCard>
  );
}
