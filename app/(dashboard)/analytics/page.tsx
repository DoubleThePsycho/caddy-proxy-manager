import { requirePermission } from "@/src/lib/auth";
import { can } from "@/src/lib/permissions";
import { getRetentionDays, isAnalyticsEnabled } from "@/src/lib/clickhouse/client";
import { getLoggingSettings } from "@/src/lib/settings";
import { visibleProxyHostDomains } from "@/src/lib/analytics/service";
import { getQuestionAvailability } from "@/ee/ai/questions/availability";
import { AskPanel } from "@/ee/ai/questions/ui/AskPanel";
import AnalyticsClient from "./AnalyticsClient";

export const metadata = { title: "Traffic analytics" };

/** Most configured host names offered as host filter suggestions. */
const MAX_HOST_SUGGESTIONS = 200;

/**
 * Traffic analytics. The page itself only knows what is configured; the
 * data comes from /api/v1/analytics in the browser, under the same
 * permission and organisation scope. The Ask box (ee/ai/questions) shows
 * why it is read-only when the license, an AI provider or the question
 * settings do not allow asking.
 */
export default async function AnalyticsPage() {
  const { access } = await requirePermission("analytics:read");
  const [logging, hosts, questions] = await Promise.all([getLoggingSettings(), visibleProxyHostDomains(access), getQuestionAvailability()]);
  const hostSuggestions = [...new Set(hosts.flatMap((host) => host.domains).filter((domain) => domain && !domain.includes("*")))]
    .sort()
    .slice(0, MAX_HOST_SUGGESTIONS);
  return (
    <AnalyticsClient
      analyticsEnabled={isAnalyticsEnabled()}
      loggingEnabled={logging?.enabled ?? false}
      retentionDays={getRetentionDays()}
      canReadSecurity={can(access, "waf:read")}
      canReadSettings={can(access, "settings:read")}
      isAdmin={access.isAdmin}
      hostSuggestions={hostSuggestions}
      ask={<AskPanel availability={questions} isAdmin={access.isAdmin} canOpenAiSettings={can(access, "ai:read")} />}
    />
  );
}
