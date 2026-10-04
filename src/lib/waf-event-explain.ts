/**
 * Explains a stored WAF event (see waf-explain.ts) with the context of the
 * proxy host that served it: the paranoia level and thresholds of the
 * settings that handle the host now, and whether each suggested exclusion
 * already exists.
 */
import { getWafEventByEventId, type WafEvent } from "./models/waf-events";
import { listProxyHosts } from "./models/proxy-hosts";
import { listWafExclusions } from "./models/waf-exclusions";
import { getWafSettings } from "./settings";
import { DEFAULT_WAF_TUNING, resolveWafTuning } from "./waf-tuning";
import { explainWafAuditRecord, type WafExclusionSuggestion, type WafExplanation } from "./waf-explain";
import { findProxyHostForRequestHost } from "./waf-suppression";

export type WafExclusionSuggestionView = WafExclusionSuggestion & {
  /** The id of an exclusion that already does exactly this, or null. */
  existingExclusionId: number | null;
};

export type WafEventExplanation = Omit<WafExplanation, "suggestions"> & {
  event: Omit<WafEvent, "id" | "rawData">;
  suggestions: WafExclusionSuggestionView[];
};

/** The explanation of the event with this id (Coraza's transaction id), or null when there is none. */
export async function explainWafEvent(eventId: string): Promise<WafEventExplanation | null> {
  const event = await getWafEventByEventId(eventId);
  if (!event) return null;
  const [global, hosts, exclusions] = await Promise.all([getWafSettings(), listProxyHosts(), listWafExclusions()]);
  const proxyHost = findProxyHostForRequestHost(hosts, event.host);
  // CRS tuning is global; a host that overrides the global settings runs the CRS defaults.
  const override = proxyHost?.waf?.waf_mode === "override" && proxyHost.waf.enabled;
  const tuning = override ? DEFAULT_WAF_TUNING : resolveWafTuning(global);
  const explanation = explainWafAuditRecord(event.rawData, {
    blockingParanoiaLevel: tuning.paranoiaLevel,
    inboundThreshold: tuning.inboundThreshold,
    outboundThreshold: tuning.outboundThreshold,
    proxyHost: proxyHost ? { id: proxyHost.id, name: proxyHost.name } : null,
    eventId,
  });
  const { id: _rowId, rawData: _rawData, ...eventFields } = event;
  void _rowId;
  void _rawData;
  return {
    ...explanation,
    event: eventFields,
    suggestions: explanation.suggestions.map((suggestion) => ({
      ...suggestion,
      existingExclusionId:
        exclusions.find(
          (exclusion) =>
            exclusion.ruleId === suggestion.ruleId &&
            exclusion.proxyHostId === suggestion.proxyHostId &&
            exclusion.path === suggestion.path &&
            exclusion.pathMatch === suggestion.pathMatch &&
            exclusion.variable === suggestion.variable
        )?.id ?? null,
    })),
  };
}
