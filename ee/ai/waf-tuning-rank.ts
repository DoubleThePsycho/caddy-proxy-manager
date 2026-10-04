// SPDX-License-Identifier: Elastic-2.0
/**
 * Ranking of WAF tuning candidates: how likely a rule firing on a host is a
 * false positive. Pure functions, no I/O.
 *
 * Signals of a false positive: many different clients over several days,
 * mostly detection-only (not blocked) or low-severity matches, clients that
 * trigger nothing else and that otherwise use the site normally, and matches
 * concentrated under one path. Rules of attack-critical families (SQL
 * injection, remote code execution, ...) never reach "high" confidence, and
 * only "low" when their matches are severe.
 */
import type { PathPrefixEvidence, SuggestionConfidence } from "./types";

/** Minimum evidence for a candidate at all. */
export const MIN_CLIENTS = 5;
export const MIN_ACTIVE_DAYS = 2;
export const MIN_EVENTS = 10;
/** Successful requests (beyond its WAF matches) that make a client look normal. */
export const NORMAL_CLIENT_MIN_OK_REQUESTS = 3;

const HIGH_SCORE = 0.7;
const MEDIUM_SCORE = 0.5;
/** Below this score the matches look like real attacks, not a false positive: nothing is suggested. */
export const MIN_SUGGESTION_SCORE = 35;

type Family = { from: number; to: number; name: string; critical: boolean };

/** OWASP CRS rule families that tuning suggestions cover (anomaly evaluation and initialization are excluded). */
export const CRS_FAMILIES: readonly Family[] = [
  { from: 911000, to: 911999, name: "Method enforcement", critical: false },
  { from: 913000, to: 913999, name: "Scanner detection", critical: false },
  { from: 920000, to: 920999, name: "Protocol enforcement", critical: false },
  { from: 921000, to: 921999, name: "Protocol attack", critical: false },
  { from: 922000, to: 922999, name: "Multipart attack", critical: false },
  { from: 930000, to: 930999, name: "Local file inclusion", critical: true },
  { from: 931000, to: 931999, name: "Remote file inclusion", critical: true },
  { from: 932000, to: 932999, name: "Remote code execution", critical: true },
  { from: 933000, to: 933999, name: "PHP injection", critical: true },
  { from: 934000, to: 934999, name: "Generic attack (Node.js, Python, SSRF)", critical: true },
  { from: 941000, to: 941999, name: "Cross-site scripting", critical: false },
  { from: 942000, to: 942999, name: "SQL injection", critical: true },
  { from: 943000, to: 943999, name: "Session fixation", critical: false },
  { from: 944000, to: 944999, name: "Java attack", critical: true },
  { from: 950000, to: 950999, name: "Data leakage", critical: false },
  { from: 951000, to: 951999, name: "SQL error leakage", critical: false },
  { from: 952000, to: 952999, name: "Java error leakage", critical: false },
  { from: 953000, to: 953999, name: "PHP error leakage", critical: false },
  { from: 954000, to: 954999, name: "IIS error leakage", critical: false },
  { from: 955000, to: 955999, name: "Web shell", critical: true },
  { from: 956000, to: 956999, name: "Ruby error leakage", critical: false },
];

export const CANDIDATE_RULE_MIN = 911000;
export const CANDIDATE_RULE_MAX = 956999;

export function ruleFamily(ruleId: number): { name: string; critical: boolean } | null {
  const family = CRS_FAMILIES.find((entry) => ruleId >= entry.from && ruleId <= entry.to);
  return family ? { name: family.name, critical: family.critical } : null;
}

export type CandidateStats = {
  ruleId: number;
  events: number;
  clients: number;
  activeDays: number;
  blockedEvents: number;
  criticalEvents: number;
  /** Average total inbound anomaly score of the events that reported one; null when none did. */
  averageAnomalyScore: number | null;
  cleanClients: number;
  /** null without traffic data */
  normalClients: number | null;
  pathPrefixes: PathPrefixEvidence[];
};

export type CandidateRanking = {
  /** Whether the candidate looks enough like a false positive to be suggested at all. */
  suggest: boolean;
  score: number;
  confidence: SuggestionConfidence;
  family: string | null;
  attackCritical: boolean;
  reasons: string[];
};

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function percent(part: number, whole: number): number {
  return whole > 0 ? Math.round((part / whole) * 100) : 0;
}

export function rankCandidate(stats: CandidateStats): CandidateRanking {
  const family = ruleFamily(stats.ruleId);
  const attackCritical = family?.critical ?? false;
  const events = Math.max(stats.events, 1);
  const clients = Math.max(stats.clients, 1);
  const blockedShare = stats.blockedEvents / events;
  const criticalShare = stats.criticalEvents / events;
  const cleanShare = stats.cleanClients / clients;
  const normalShare = stats.normalClients === null ? null : stats.normalClients / clients;
  const topPrefix = stats.pathPrefixes[0];
  const prefixShare = topPrefix ? topPrefix.events / events : 0;

  const spread = clamp(Math.log10(clients) / 2); // 10 clients → 0.5, 100 → 1
  const persistence = clamp(stats.activeDays / 7);
  const detection = 1 - blockedShare;
  const anomaly = stats.averageAnomalyScore === null ? 1 - criticalShare : 0.5 * (1 - criticalShare) + 0.5 * clamp(1 - (stats.averageAnomalyScore - 5) / 20);
  const weights: [number, number][] = [
    [spread, 0.15],
    [persistence, 0.15],
    [detection, 0.2],
    [anomaly, 0.1],
    [cleanShare, 0.2],
  ];
  if (normalShare !== null) weights.push([normalShare, 0.2]);
  const totalWeight = weights.reduce((sum, [, weight]) => sum + weight, 0);
  const score = weights.reduce((sum, [value, weight]) => sum + value * weight, 0) / totalWeight;

  const severe = criticalShare >= 0.5 || (stats.averageAnomalyScore ?? 0) >= 15 || blockedShare >= 0.8;
  let confidence: SuggestionConfidence = score >= HIGH_SCORE && cleanShare >= 0.6 && stats.clients >= 10 ? "high" : score >= MEDIUM_SCORE ? "medium" : "low";
  if (attackCritical && confidence === "high") confidence = "medium";
  if (attackCritical && severe) confidence = "low";

  const reasons = [
    `Matched ${stats.events} time${stats.events === 1 ? "" : "s"} for ${stats.clients} different client${stats.clients === 1 ? "" : "s"} on ${stats.activeDays} day${stats.activeDays === 1 ? "" : "s"}`,
    `${percent(stats.events - stats.blockedEvents, stats.events)}% of the matches did not block the request (detection-only or below the anomaly threshold)`,
    `${stats.cleanClients} of ${stats.clients} clients triggered no other WAF rule`,
  ];
  if (stats.normalClients !== null) {
    reasons.push(`${stats.normalClients} of ${stats.clients} clients also made successful requests to this host`);
  }
  if (stats.averageAnomalyScore !== null) reasons.push(`Average anomaly score when the threshold was exceeded: ${stats.averageAnomalyScore}`);
  if (stats.criticalEvents > 0) reasons.push(`${percent(stats.criticalEvents, stats.events)}% of the matches had critical severity`);
  if (topPrefix && prefixShare >= 0.5) reasons.push(`${percent(topPrefix.events, stats.events)}% of the matches are under ${topPrefix.prefix}`);
  if (attackCritical) {
    reasons.push(
      `${family?.name} rule: turning it off for the host removes protection against a critical attack class, so this is never a high-confidence suggestion`
    );
  }

  const rounded = Math.round(score * 100);
  return { suggest: rounded >= MIN_SUGGESTION_SCORE, score: rounded, confidence, family: family?.name ?? null, attackCritical, reasons };
}

const CONFIDENCE_ORDER: Record<SuggestionConfidence, number> = { high: 0, medium: 1, low: 2 };

/** Highest confidence first, then by volume (events, then clients). */
export function compareSuggestions(
  a: { confidence: SuggestionConfidence; events: number; clients: number; score: number },
  b: { confidence: SuggestionConfidence; events: number; clients: number; score: number }
): number {
  return (
    CONFIDENCE_ORDER[a.confidence] - CONFIDENCE_ORDER[b.confidence] ||
    b.events - a.events ||
    b.clients - a.clients ||
    b.score - a.score
  );
}
