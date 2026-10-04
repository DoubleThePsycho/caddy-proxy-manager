// SPDX-License-Identifier: Elastic-2.0
import { requirePermission } from "@/src/lib/auth";
import { can, scopeTagsFor } from "@/src/lib/permissions";
import { organizationFilterFor } from "@/ee/multi-tenancy/scope";
import { listProxyHosts } from "@/src/lib/models/proxy-hosts";
import { listAlertChannels } from "@/ee/alerting/channels";
import { listAlertRules } from "@/ee/alerting/rules";
import { listAlertEvents, listFiringAlerts } from "@/ee/alerting/events";
import { getAlertingLicenseView } from "@/ee/alerting/gate";
import { getAiSettingsView } from "@/ee/ai/settings";
import { getDigestSettingsView } from "@/ee/ai/digest-settings";
import { getQuestionSettings } from "@/ee/ai/questions/settings";
import AlertsClient, { type AlertsTab } from "./AlertsClient";

export const metadata = { title: "Alerts" };

const HISTORY_PER_PAGE = 25;
/** The newest events read for the "Last 7 days" table. */
const RECENT_EVENTS = 200;
const TABS: readonly AlertsTab[] = ["firing", "rules", "channels", "ai", "history"];

interface PageProps {
  searchParams: Promise<{ tab?: string; page?: string }>;
}

export default async function AlertsPage({ searchParams }: PageProps) {
  const { access } = await requirePermission("alerts:read");
  // The AI tab (provider settings and the digest) is the ai area.
  const canAi = can(access, "ai:read");
  const canWrite = can(access, "alerts:write");
  const { tab: tabParam, page: pageParam } = await searchParams;
  const tab = TABS.find((candidate) => candidate === tabParam && (candidate !== "ai" || canAi)) ?? "firing";
  const page = Math.max(1, Number.parseInt(pageParam ?? "1", 10) || 1);
  const now = Date.now();
  // Every view below is already free of credentials; proxy hosts are reduced to ids and names.
  const [channels, rules, firing, recent, history, hosts, ai, digest, license, questions] = await Promise.all([
    listAlertChannels(),
    listAlertRules(),
    listFiringAlerts(),
    listAlertEvents({ page: 1, perPage: RECENT_EVENTS }),
    tab === "history"
      ? listAlertEvents({ page, perPage: HISTORY_PER_PAGE })
      : Promise.resolve({ events: [], total: 0, page: 1, perPage: HISTORY_PER_PAGE }),
    // Only the hosts the user may read are offered and named.
    can(access, "proxy_hosts:read")
      ? listProxyHosts(scopeTagsFor(access, "proxy_hosts"), organizationFilterFor(access))
      : Promise.resolve([]),
    getAiSettingsView(),
    getDigestSettingsView(),
    getAlertingLicenseView(),
    getQuestionSettings(),
  ]);
  const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
  return (
    <AlertsClient
      initialTab={tab}
      channels={channels}
      rules={rules}
      firing={firing}
      recent={recent.events.filter((event) => event.createdAt >= weekAgo)}
      history={history}
      ai={ai}
      digest={digest}
      questions={questions}
      license={license}
      canAi={canAi}
      canWrite={canWrite}
      proxyHosts={hosts.map((host) => ({ id: host.id, name: host.name || host.domains[0] || `Host #${host.id}` })).sort((a, b) => a.name.localeCompare(b.name))}
      now={now}
    />
  );
}
