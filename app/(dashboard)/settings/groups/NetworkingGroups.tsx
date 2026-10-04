"use client";

import { useState } from "react";
import { SectionCard } from "@/components/ui/SectionCard";
import { Textarea } from "@/components/ui/textarea";
import type { TrustedProxiesSettings, UpstreamDnsResolutionSettings } from "@/lib/settings";
import { useBranding } from "@/ee/white-label/ui/BrandingProvider";
import { updateTrustedProxiesSettingsAction, updateUpstreamDnsResolutionSettingsAction } from "../actions";
import { CardNote, ChoiceField, OverrideRow, SettingRow, SettingRows, SettingsForm, SettingsGroupForms, ToggleField } from "@/src/components/settings/settings-form";

export function TrustedProxiesGroup({
  trustedProxies,
  isSlave,
  override: initialOverride,
  canSave,
  onDirtyChange,
}: {
  trustedProxies: TrustedProxiesSettings | null;
  isSlave: boolean;
  override: boolean;
  canSave: boolean;
  onDirtyChange: (count: number) => void;
}) {
  const { productName } = useBranding();
  const [override, setOverride] = useState(initialOverride);
  const disabled = isSlave && !override;
  return (
    <SettingsGroupForms name="Trusted proxies" canSave={canSave} onDirtyChange={onDirtyChange}>
      <SectionCard
        title="Trusted proxies"
        description={`When ${productName} runs behind a load balancer or CDN, Caddy takes the client address from these proxies' headers.`}
        headingLevel={3}
        divided={false}
      >
        <SettingsForm action={updateTrustedProxiesSettingsAction}>
          <SettingRows>
            {isSlave && <OverrideRow id="trusted-proxies-override" checked={override} onCheckedChange={setOverride} />}
            <SettingRow
              label="Trusted ranges"
              htmlFor="settings-trusted-ranges"
              hint="CIDR ranges or addresses, one per line, or private_ranges for every private network. Empty keeps Caddy's default."
            >
              <Textarea
                id="settings-trusted-ranges"
                name="ranges"
                defaultValue={(trustedProxies?.ranges ?? []).join("\n")}
                disabled={disabled}
                rows={2}
                placeholder={"private_ranges\n172.21.0.1/32"}
                className="num min-h-0"
              />
            </SettingRow>
            <SettingRow
              label="Client address headers"
              htmlFor="settings-client-ip-headers"
              hint="One per line. Empty means X-Forwarded-For; Cloudflare sends Cf-Connecting-Ip."
            >
              <Textarea
                id="settings-client-ip-headers"
                name="clientIpHeaders"
                defaultValue={(trustedProxies?.client_ip_headers ?? []).join("\n")}
                disabled={disabled}
                rows={1}
                placeholder="X-Forwarded-For"
                className="num min-h-0"
              />
            </SettingRow>
            <SettingRow label="Strict mode" hint="Spoofed values from anyone else are ignored.">
              <ToggleField
                id="trusted-proxies-strict"
                name="strict"
                label="Accept these headers only from trusted proxies"
                defaultChecked={trustedProxies?.strict ?? false}
                disabled={disabled}
              />
            </SettingRow>
            <SettingRow label="Geo blocking" hint="A trusted proxy list set on geo blocking itself wins.">
              <ToggleField
                id="trusted-proxies-geoblock"
                name="defaultGeoblock"
                label="Use these ranges for geo blocking too"
                defaultChecked={trustedProxies?.default_geoblock ?? false}
                disabled={disabled}
              />
            </SettingRow>
          </SettingRows>
        </SettingsForm>
        <CardNote>
          Applied to the main HTTP server, so access logs, analytics, the country map and anything using{" "}
          <span className="num">{"{http.request.client_ip}"}</span> see the real client address.
        </CardNote>
      </SectionCard>
    </SettingsGroupForms>
  );
}

type Family = UpstreamDnsResolutionSettings["family"];

export function UpstreamDnsGroup({
  upstreamDnsResolution,
  isSlave,
  override: initialOverride,
  canSave,
  onDirtyChange,
}: {
  upstreamDnsResolution: UpstreamDnsResolutionSettings | null;
  isSlave: boolean;
  override: boolean;
  canSave: boolean;
  onDirtyChange: (count: number) => void;
}) {
  const [override, setOverride] = useState(initialOverride);
  const [family, setFamily] = useState<Family>(upstreamDnsResolution?.family ?? "both");
  const disabled = isSlave && !override;
  return (
    <SettingsGroupForms name="Upstream DNS pinning" canSave={canSave} onDirtyChange={onDirtyChange}>
      <SectionCard title="Upstream DNS pinning" headingLevel={3} divided={false}>
        <SettingsForm action={updateUpstreamDnsResolutionSettingsAction}>
          <SettingRows>
            {isSlave && <OverrideRow id="udns-override" checked={override} onCheckedChange={setOverride} />}
            <SettingRow
              label="Pin upstream addresses"
              hint="Writes the resolved addresses into Caddy's configuration each time it is applied. A host can override this."
            >
              <ToggleField
                id="udns-enabled"
                name="enabled"
                label="Resolve upstream hostnames when applying"
                defaultChecked={upstreamDnsResolution?.enabled ?? false}
                disabled={disabled}
              />
            </SettingRow>
            <SettingRow label="Address family" labelId="settings-udns-family" hint="Both resolves AAAA and A records, IPv6 first.">
              <ChoiceField
                name="family"
                label="Address family"
                value={family}
                onChange={setFamily}
                disabled={disabled}
                options={[
                  { value: "both", label: "Both, prefer IPv6" },
                  { value: "ipv4", label: "IPv4 only" },
                  { value: "ipv6", label: "IPv6 only" },
                ]}
              />
            </SettingRow>
          </SettingRows>
        </SettingsForm>
        <CardNote>
          When one handler has several different HTTPS upstream hostnames, pinning is skipped for those upstreams to avoid a TLS
          server name mismatch.
        </CardNote>
      </SectionCard>
    </SettingsGroupForms>
  );
}
