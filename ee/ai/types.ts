// SPDX-License-Identifier: Elastic-2.0
/**
 * AI analyst: shared types for the daily digest and WAF tuning suggestions.
 * Safe to import from client components (no server-only dependencies).
 */

/** How long one model call may take, in seconds (the ai_provider setting); settings saved without it get the default. */
export const DEFAULT_AI_TIMEOUT_SECONDS = 60;
export const MIN_AI_TIMEOUT_SECONDS = 5;
export const MAX_AI_TIMEOUT_SECONDS = 300;

export const AI_GENERATED_SUMMARY_LABEL = "AI-generated summary";
export const AI_GENERATED_RISK_LABEL = "AI-generated risk assessment";

// ── Daily security digest ─────────────────────────────────────────────

/**
 * What happened to the AI narrative of a digest: added, not asked for
 * ("off"), no provider configured ("unavailable"), or the call failed,
 * timed out or was refused ("failed").
 */
export type NarrativeStatus = "added" | "off" | "unavailable" | "failed";

export type DigestDelivery = { channelId: number; channelName: string; ok: boolean; error: string | null };

export type DigestRunRecord = {
  /** ISO 8601 */
  at: string;
  trigger: "scheduled" | "manual";
  narrative: NarrativeStatus;
  deliveries: DigestDelivery[];
};

export type DigestSettingsView = {
  enabled: boolean;
  /** "HH:MM", 24-hour clock, in `timeZone`. */
  timeOfDay: string;
  /** IANA time zone, e.g. "Europe/Rome". */
  timeZone: string;
  channelIds: number[];
  /** Add a short AI-generated narrative when a provider is configured. */
  ai: boolean;
  /** Next scheduled send (ISO 8601), null while disabled. */
  nextRunAt: string | null;
  lastRun: DigestRunRecord | null;
};

export type DigestPreview = {
  subject: string;
  text: string;
  html: string;
  narrative: { status: NarrativeStatus; error: string | null };
  facts: Record<string, unknown>;
};

export type DigestSendResult = {
  narrative: { status: NarrativeStatus; error: string | null };
  deliveries: DigestDelivery[];
};

// ── WAF tuning suggestions ────────────────────────────────────────────

export type SuggestionConfidence = "high" | "medium" | "low";
export type SuggestionStatus = "open" | "applied" | "dismissed";

export type PathPrefixEvidence = {
  /** First one or two path segments, e.g. "/api/upload". */
  prefix: string;
  events: number;
  clients: number;
  /** Example request paths under the prefix, query strings removed. */
  examplePaths: string[];
};

export type SuggestionEvidence = {
  windowDays: number;
  events: number;
  clients: number;
  activeDays: number;
  /** Events where the WAF interrupted the request. */
  blockedEvents: number;
  /** Events the rule reported without blocking (detection-only mode or below the anomaly threshold). */
  detectionOnlyEvents: number;
  /** Events whose matched rule had CRITICAL severity. */
  criticalEvents: number;
  /** Average total inbound anomaly score of the events that reported one, null when none did. */
  averageAnomalyScore: number | null;
  /** Clients that triggered no other WAF rule in the window. */
  cleanClients: number;
  /** Clients with at least a few successful (2xx/3xx) requests to the same host; null without traffic data. */
  normalClients: number | null;
  /** ISO 8601 */
  firstSeen: string;
  lastSeen: string;
  pathPrefixes: PathPrefixEvidence[];
};

export type WafTuningSuggestionView = {
  /** Stable id: `{ruleId}-{hash of the host}`. */
  id: string;
  host: string;
  proxyHost: { id: number; name: string };
  ruleId: number;
  ruleMessage: string | null;
  ruleFamily: string | null;
  /** Attack-critical rule family (e.g. SQL injection, remote code execution): never "high" confidence. */
  attackCritical: boolean;
  confidence: SuggestionConfidence;
  /** 0 to 100 */
  score: number;
  reasons: string[];
  exclusion: {
    type: "host_rule_suppression";
    proxyHostId: number;
    ruleId: number;
    description: string;
  };
  evidence: SuggestionEvidence;
  explanation: { label: string; text: string } | null;
  status: SuggestionStatus;
  generatedAt: string;
};

export type WafTuningResult = {
  analyticsEnabled: boolean;
  windowDays: number;
  generatedAt: string;
  suggestions: WafTuningSuggestionView[];
  /** Set when ClickHouse could not be queried (the stored suggestions are left as they were). */
  error: string | null;
  /** Set when explanations were requested but could not be produced for every suggestion. */
  explanationError: string | null;
};
