"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { SectionCard } from "@/components/ui/SectionCard";
import { StatusDot } from "@/components/ui/StatusDot";
import { GeoBlockFields } from "@/components/proxy-hosts/GeoBlockFields";
import { ErrorPagesFields } from "@/components/proxy-hosts/ErrorPagesFields";
import { RateLimitSettingsFields } from "@/components/proxy-hosts/RateLimitFields";
import type { AuthentikSettings, ErrorPagesSettings, ForwardAuthSettings, GeoBlockSettings, RateLimitSettings } from "@/lib/settings";
import type { GeoIpDatabaseView } from "@/src/lib/geoip-status";
import { formatDateTimeUtc } from "@/src/lib/date-format";
import {
  updateAuthentikSettingsAction,
  updateErrorPagesSettingsAction,
  updateForwardAuthSettingsAction,
  updateGeoBlockSettingsAction,
  updateRateLimitSettingsAction,
} from "../actions";
import { CardNote, ChoiceField, OverrideRow, SettingRow, SettingRows, SettingsForm, SettingsGroupForms } from "@/src/components/settings/settings-form";

export function GeoGroup({
  globalGeoBlock,
  geoip,
  canSave,
  onDirtyChange,
}: {
  globalGeoBlock: GeoBlockSettings | null;
  geoip: GeoIpDatabaseView[];
  canSave: boolean;
  onDirtyChange: (count: number) => void;
}) {
  const missing = geoip.filter((database) => !database.found);
  return (
    <SettingsGroupForms name="Geo blocking and GeoIP" canSave={canSave} onDirtyChange={onDirtyChange}>
      <SectionCard
        title="GeoIP databases"
        description="Country and network lookups for geo blocking and analytics."
        headingLevel={3}
        divided={false}
      >
        <SettingRows>
          {geoip.map((database) => (
            <SettingRow
              key={database.path}
              label={database.name}
              note={database.updatedAt ? `Updated ${formatDateTimeUtc(database.updatedAt)} UTC` : undefined}
            >
              <span className="flex min-h-9 items-center">
                <StatusDot
                  tone={database.found ? "ok" : "bad"}
                  label={
                    <span className="text-[13px] [overflow-wrap:anywhere]">
                      {database.found ? "Found" : "Missing"} · <span className="num">{database.path}</span>
                    </span>
                  }
                />
              </span>
            </SettingRow>
          ))}
          <SettingRow label="Updates" note="Caddy and the dashboard read the same files.">
            <span className="flex min-h-9 items-center text-[13px]">
              By the geoipupdate service, when it runs (docker compose --profile geoipupdate).
            </span>
          </SettingRow>
        </SettingRows>
        {missing.length > 0 && (
          <CardNote tone="warn">
            {missing.length === geoip.length
              ? "Without the databases, country, continent and network rules do not match, and analytics show no countries."
              : `${missing.map((database) => database.name).join(" and ")} is missing, so the rules that need it do not match.`}{" "}
            Turn on the geoipupdate service with a MaxMind account to download them.
          </CardNote>
        )}
      </SectionCard>
      <SectionCard
        title="Default rules"
        description="Apply to every host. A host's own rules are merged with these."
        headingLevel={3}
        divided={false}
      >
        <SettingsForm action={updateGeoBlockSettingsAction} className="border-t border-line px-5 py-4">
          <GeoBlockFields initialValues={{ geoblock: globalGeoBlock ?? null, geoblock_mode: "merge" }} showModeSelector={false} />
        </SettingsForm>
      </SectionCard>
    </SettingsGroupForms>
  );
}

export function RateLimitGroup({
  globalRateLimit,
  canSave,
  onDirtyChange,
}: {
  globalRateLimit: RateLimitSettings | null;
  canSave: boolean;
  onDirtyChange: (count: number) => void;
}) {
  return (
    <SettingsGroupForms name="Rate limiting" canSave={canSave} onDirtyChange={onDirtyChange}>
      <SectionCard
        title="Default rules"
        description="Requests over a limit get 429 Too Many Requests with Retry-After. Each Caddy node counts on its own, and each proxy host has its own counters."
        headingLevel={3}
        divided={false}
      >
        <SettingsForm action={updateRateLimitSettingsAction} className="border-t border-line px-5 py-4">
          <RateLimitSettingsFields value={globalRateLimit ?? null} />
        </SettingsForm>
      </SectionCard>
    </SettingsGroupForms>
  );
}

export function ErrorPagesGroup({
  globalErrorPages,
  canSave,
  onDirtyChange,
}: {
  globalErrorPages: ErrorPagesSettings | null;
  canSave: boolean;
  onDirtyChange: (count: number) => void;
}) {
  return (
    <SettingsGroupForms name="Error pages" canSave={canSave} onDirtyChange={onDirtyChange}>
      <SectionCard
        title="Fallback error pages"
        description="Sent for every host. A host's own error page for the same status wins."
        headingLevel={3}
        divided={false}
      >
        <SettingsForm action={updateErrorPagesSettingsAction} className="border-t border-line px-5 py-4">
          <ErrorPagesFields initialData={globalErrorPages?.rules ?? []} />
        </SettingsForm>
      </SectionCard>
    </SettingsGroupForms>
  );
}

export function ForwardAuthGroup({
  authentik,
  forwardAuth,
  isSlave,
  overrides,
  canSave,
  onDirtyChange,
}: {
  authentik: AuthentikSettings | null;
  forwardAuth: ForwardAuthSettings | null;
  isSlave: boolean;
  overrides: { authentik: boolean; forwardAuth: boolean };
  canSave: boolean;
  onDirtyChange: (count: number) => void;
}) {
  const [authentikOverride, setAuthentikOverride] = useState(overrides.authentik);
  const [forwardAuthOverride, setForwardAuthOverride] = useState(overrides.forwardAuth);
  const [preset, setPreset] = useState<ForwardAuthSettings["provider"]>(forwardAuth?.provider ?? "authelia");
  const authentikDisabled = isSlave && !authentikOverride;
  const forwardAuthDisabled = isSlave && !forwardAuthOverride;
  return (
    <SettingsGroupForms name="Forward auth defaults" canSave={canSave} onDirtyChange={onDirtyChange}>
      <SectionCard
        id="settings-authentik"
        className="scroll-mt-4"
        title="Authentik"
        description="Filled in when you turn on Authentik for a new proxy host."
        headingLevel={3}
        divided={false}
      >
        <SettingsForm action={updateAuthentikSettingsAction} order={0}>
          <SettingRows>
            {isSlave && <OverrideRow id="authentik-override" checked={authentikOverride} onCheckedChange={setAuthentikOverride} />}
            <SettingRow label="Outpost domain" htmlFor="settings-authentik-domain">
              <Input
                id="settings-authentik-domain"
                name="outpostDomain"
                placeholder="outpost.goauthentik.io"
                defaultValue={authentik?.outpostDomain ?? ""}
                required
                disabled={authentikDisabled}
                className="num"
              />
            </SettingRow>
            <SettingRow label="Outpost upstream" htmlFor="settings-authentik-upstream">
              <Input
                id="settings-authentik-upstream"
                name="outpostUpstream"
                placeholder="http://authentik-server:9000"
                defaultValue={authentik?.outpostUpstream ?? ""}
                required
                disabled={authentikDisabled}
                className="num"
              />
            </SettingRow>
            <SettingRow label="Auth endpoint" htmlFor="settings-authentik-endpoint">
              <Input
                id="settings-authentik-endpoint"
                name="authEndpoint"
                placeholder="/outpost.goauthentik.io/auth/caddy"
                defaultValue={authentik?.authEndpoint ?? ""}
                disabled={authentikDisabled}
                className="num"
              />
            </SettingRow>
          </SettingRows>
        </SettingsForm>
      </SectionCard>
      <SectionCard
        id="settings-generic-forward-auth"
        className="scroll-mt-4"
        title="Generic forward auth"
        description="Filled in when you turn on forward auth with Authelia or another server for a new proxy host."
        headingLevel={3}
        divided={false}
      >
        <SettingsForm action={updateForwardAuthSettingsAction} order={1}>
          <SettingRows>
            {isSlave && (
              <OverrideRow id="forward-auth-override" checked={forwardAuthOverride} onCheckedChange={setForwardAuthOverride} />
            )}
            <SettingRow label="Provider preset" labelId="settings-forward-auth-preset">
              <ChoiceField
                name="provider"
                label="Provider preset"
                value={preset}
                onChange={setPreset}
                disabled={forwardAuthDisabled}
                options={[
                  { value: "authelia", label: "Authelia" },
                  { value: "custom", label: "Custom" },
                ]}
              />
            </SettingRow>
            <SettingRow label="Auth server URL" htmlFor="settings-forward-auth-upstream">
              <Input
                id="settings-forward-auth-upstream"
                name="authUpstream"
                placeholder="http://authelia:9091"
                defaultValue={forwardAuth?.authUpstream ?? ""}
                required
                disabled={forwardAuthDisabled}
                className="num"
              />
            </SettingRow>
            <SettingRow
              label="Auth endpoint"
              htmlFor="settings-forward-auth-endpoint"
              hint="Optional. Authelia hosts get /api/authz/forward-auth when it is blank."
            >
              <Input
                id="settings-forward-auth-endpoint"
                name="authEndpoint"
                placeholder="/api/authz/forward-auth"
                defaultValue={forwardAuth?.authEndpoint ?? ""}
                disabled={forwardAuthDisabled}
                className="num"
              />
            </SettingRow>
          </SettingRows>
        </SettingsForm>
      </SectionCard>
    </SettingsGroupForms>
  );
}
