"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { KpiTile } from "@/components/ui/KpiTile";
import { SectionCard } from "@/components/ui/SectionCard";
import { StatusDot } from "@/components/ui/StatusDot";
import { formatBytes, formatCompact, formatCount } from "@/components/ui/chart-format";
import type { LoggingSettings, MetricsSettings } from "@/lib/settings";
import { updateLoggingSettingsAction, updateMetricsSettingsAction } from "../actions";
import { CardNote, ChoiceField, OverrideRow, SettingRow, SettingRows, SettingsForm, SettingsGroupForms, ToggleField } from "@/src/components/settings/settings-form";
import type { AnalyticsStatusView } from "../types";

type LogFormat = NonNullable<LoggingSettings["format"]>;

export default function AnalyticsGroup({
  analytics,
  logging,
  metrics,
  isSlave,
  overrides,
  canSave,
  onDirtyChange,
}: {
  analytics: AnalyticsStatusView;
  logging: LoggingSettings | null;
  metrics: MetricsSettings | null;
  isSlave: boolean;
  overrides: { logging: boolean; metrics: boolean };
  canSave: boolean;
  onDirtyChange: (count: number) => void;
}) {
  return (
    <SettingsGroupForms name="Analytics and logs" canSave={canSave} onDirtyChange={onDirtyChange}>
      <TrafficAnalyticsCard analytics={analytics} />
      <AccessLogCard logging={logging} isSlave={isSlave} override={overrides.logging} />
      <MetricsCard metrics={metrics} isSlave={isSlave} override={overrides.metrics} />
    </SettingsGroupForms>
  );
}

function TrafficAnalyticsCard({ analytics }: { analytics: AnalyticsStatusView }) {
  const window = `last ${analytics.retentionDays} ${analytics.retentionDays === 1 ? "day" : "days"}`;
  const totals = analytics.totals;
  return (
    <SectionCard
      title="Traffic analytics"
      description="Every request and WAF event from the access log, stored in ClickHouse, with country and network from GeoLite2."
      headingLevel={3}
      divided={false}
    >
      {totals && (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(150px,100%),1fr))] gap-2.5 px-5 pb-4">
          <KpiTile label="Requests" value={formatCompact(totals.requests)} note={window} />
          <KpiTile label="WAF events" value={formatCount(totals.wafEvents)} note={window} />
          <KpiTile label="Sent" value={formatBytes(totals.bytes)} note={window} />
          <KpiTile label="Unique addresses" value={formatCount(totals.uniqueAddresses)} note={window} />
        </div>
      )}
      <SettingRows>
        <SettingRow
          label="ClickHouse"
          note={
            analytics.enabled
              ? "Set by CLICKHOUSE_URL, CLICKHOUSE_USER, CLICKHOUSE_PASSWORD and CLICKHOUSE_DB in the environment."
              : "Set CLICKHOUSE_PASSWORD in the environment and recreate the web container to turn traffic analytics on."
          }
        >
          <span className="flex min-h-9 items-center">
            {!analytics.enabled ? (
              <StatusDot tone="off" label="Off: CLICKHOUSE_PASSWORD is not set" />
            ) : analytics.totalsError ? (
              <StatusDot tone="warn" label={analytics.totalsError} />
            ) : (
              <StatusDot tone="ok" label="Connected" />
            )}
          </span>
        </SettingRow>
        <SettingRow
          label="Keep events for"
          note={
            analytics.retentionFromEnv
              ? "Set by CLICKHOUSE_RETENTION_DAYS. ClickHouse deletes older events itself; to keep them longer, change it and recreate the web container."
              : "The default. Set CLICKHOUSE_RETENTION_DAYS and recreate the web container to keep events longer or shorter."
          }
        >
          <span className="num flex min-h-9 items-center text-[13px]">
            {analytics.retentionDays} {analytics.retentionDays === 1 ? "day" : "days"}
          </span>
        </SettingRow>
      </SettingRows>
    </SectionCard>
  );
}

function AccessLogCard({ logging, isSlave, override: initialOverride }: { logging: LoggingSettings | null; isSlave: boolean; override: boolean }) {
  const [override, setOverride] = useState(initialOverride);
  const [enabled, setEnabled] = useState(logging?.enabled ?? false);
  const [format, setFormat] = useState<LogFormat>(logging?.format ?? "json");
  const disabled = isSlave && !override;
  return (
    <SectionCard id="settings-access-log" className="scroll-mt-4" title="Access log" headingLevel={3} divided={false}>
      <SettingsForm action={updateLoggingSettingsAction} order={0}>
        <SettingRows>
          {isSlave && <OverrideRow id="logging-override" checked={override} onCheckedChange={setOverride} />}
          <SettingRow label="Access logging" hint="Traffic analytics are read from this log.">
            <ToggleField
              id="logging-enabled"
              name="enabled"
              label="Log every proxied request"
              checked={enabled}
              onCheckedChange={setEnabled}
              disabled={disabled}
            />
          </SettingRow>
          <SettingRow label="Format" labelId="settings-log-format">
            <ChoiceField
              name="format"
              label="Log format"
              value={format}
              onChange={setFormat}
              disabled={disabled}
              options={[
                { value: "json", label: "JSON" },
                { value: "console", label: "Console (Common Log Format)" },
              ]}
            />
          </SettingRow>
          <SettingRow label="Stored in" note="To follow it: docker exec ingressi-caddy tail -f /logs/access.log">
            <span className="num flex min-h-9 items-center text-[13px]">caddy-logs volume · /logs/access.log</span>
          </SettingRow>
        </SettingRows>
      </SettingsForm>
      {!enabled && (
        <CardNote tone="warn">With access logging off, Caddy writes no access log, so traffic analytics receive no new requests.</CardNote>
      )}
    </SectionCard>
  );
}

function MetricsCard({ metrics, isSlave, override: initialOverride }: { metrics: MetricsSettings | null; isSlave: boolean; override: boolean }) {
  const [override, setOverride] = useState(initialOverride);
  const [port, setPort] = useState(String(metrics?.port ?? 9090));
  const disabled = isSlave && !override;
  return (
    <SectionCard id="settings-metrics" className="scroll-mt-4" title="Prometheus metrics" headingLevel={3} divided={false}>
      <SettingsForm action={updateMetricsSettingsAction} order={1}>
        <SettingRows>
          {isSlave && <OverrideRow id="metrics-override" checked={override} onCheckedChange={setOverride} />}
          <SettingRow label="Metrics endpoint" hint="A Prometheus scrape endpoint.">
            <ToggleField
              id="metrics-enabled"
              name="enabled"
              label="Expose /metrics on its own port"
              defaultChecked={metrics?.enabled ?? false}
              disabled={disabled}
            />
          </SettingRow>
          <SettingRow label="Port" htmlFor="settings-metrics-port" hint="Separate from the admin API on port 2019.">
            <Input
              id="settings-metrics-port"
              name="port"
              type="number"
              min={1}
              max={65535}
              value={port}
              onChange={(event) => setPort(event.target.value)}
              disabled={disabled}
              className="num w-[120px]"
            />
          </SettingRow>
          <SettingRow label="Scrape from" note="Reachable from inside the Docker network only.">
            <span className="num flex min-h-9 items-center text-[13px] [overflow-wrap:anywhere]">
              http://ingressi-caddy:{port || "9090"}/metrics
            </span>
          </SettingRow>
        </SettingRows>
      </SettingsForm>
    </SectionCard>
  );
}
