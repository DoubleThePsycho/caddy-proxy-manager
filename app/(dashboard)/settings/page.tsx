import { redirect } from "next/navigation";
import { requirePermission } from "@/src/lib/auth";
import { can } from "@/src/lib/permissions";
import { config } from "@/src/lib/config";
import { getGeneralSettings } from "@/src/lib/settings";
import { settingsSectionHref } from "@/src/lib/settings-sections";
import { loadReplicaOverrides } from "./load";
import SettingsClient from "./SettingsClient";

export const metadata = { title: "Settings" };

type SearchParams = { section?: string | string[]; group?: string | string[] };

export default async function SettingsPage({ searchParams }: { searchParams?: Promise<SearchParams> } = {}) {
  const { access } = await requirePermission("settings:read");

  // Links to a section of the old Settings page go to the page that holds it now.
  const params = (await searchParams) ?? {};
  const old = [params.section, params.group].find((value): value is string => typeof value === "string");
  const moved = old ? settingsSectionHref(old) : null;
  if (moved) redirect(moved);

  const [general, replica] = await Promise.all([getGeneralSettings(), loadReplicaOverrides({ general: "general" })]);

  return (
    <SettingsClient
      general={general}
      baseUrl={config.baseUrl}
      isSlave={replica.isSlave}
      overrideGeneral={replica.overrides.general}
      canWriteSettings={can(access, "settings:write")}
    />
  );
}
