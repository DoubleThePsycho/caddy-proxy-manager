export const dynamic = 'force-dynamic';

import WafSettingsClient, { type WafSettingsPageData } from "./WafSettingsClient";
import { requirePermission } from "@/src/lib/auth";
import { can } from "@/src/lib/permissions";
import { getSettingUpdatedAt, getWafSettings } from "@/src/lib/settings";
import { listProxyHosts } from "@/src/lib/models/proxy-hosts";
import { countWafExclusionsByScope, listWafExclusions } from "@/src/lib/models/waf-exclusions";
import {
  getTopWafRules,
  getWafDailyCounts,
  getWafHostCounts,
  getWafPeriodSummary,
  getWafRuleMessages,
} from "@/src/lib/models/waf-events";
import { listDroppedWafDirectives } from "@/src/lib/caddy-waf";
import { isAnalyticsEnabled } from "@/src/lib/clickhouse/client";
import { wafHostView } from "@/src/lib/waf-hosts";
import { bareRequestHost } from "@/src/lib/waf-suppression";

const WEEK_SECONDS = 7 * 24 * 60 * 60;

/** The global WAF settings: mode, Core Rule Set tuning, request bodies, per-host modes, rule exclusions and custom rules. */
export default async function WafPage() {
  const { access } = await requirePermission("waf:read");
  const to = Math.floor(Date.now() / 1000);
  const from = to - WEEK_SECONDS;

  const [settings, savedAt, hosts, exclusions, exclusionCounts, summary, daily, topRules, hostCounts] = await Promise.all([
    getWafSettings(),
    getSettingUpdatedAt("waf"),
    listProxyHosts(),
    listWafExclusions(),
    countWafExclusionsByScope(),
    getWafPeriodSummary(from, to),
    getWafDailyCounts(from, to),
    getTopWafRules(from, to, 10),
    getWafHostCounts(from, to),
  ]);
  const ruleMessages = await getWafRuleMessages([...new Set(exclusions.map((exclusion) => exclusion.ruleId))]);

  // Events are stored by request host (with any port); count them per proxy host.
  const hostIdByDomain = new Map<string, number>();
  for (const host of hosts) for (const domain of host.domains) hostIdByDomain.set(domain.toLowerCase(), host.id);
  const eventsByHost = new Map<number, { count: number; blocked: number }>();
  for (const row of hostCounts) {
    const id = hostIdByDomain.get(bareRequestHost(row.host).toLowerCase());
    if (id === undefined) continue;
    const current = eventsByHost.get(id) ?? { count: 0, blocked: 0 };
    eventsByHost.set(id, { count: current.count + row.count, blocked: current.blocked + row.blocked });
  }

  const data: WafSettingsPageData = {
    settings,
    savedAt,
    canWrite: can(access, "waf:write"),
    analyticsEnabled: isAnalyticsEnabled(),
    hosts: hosts
      .map((host) => ({
        ...wafHostView(host, settings, exclusionCounts.get(host.id) ?? 0),
        events: eventsByHost.get(host.id) ?? { count: 0, blocked: 0 },
      }))
      .sort((a, b) => b.events.count - a.events.count || a.name.localeCompare(b.name)),
    exclusions: exclusions.map((exclusion) => ({ ...exclusion, ruleMessage: ruleMessages[exclusion.ruleId] ?? null })),
    week: { from, to, summary, daily, topRules },
    droppedDirectives: listDroppedWafDirectives(settings, hosts),
  };

  return <WafSettingsClient data={data} />;
}
