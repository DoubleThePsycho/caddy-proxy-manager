/**
 * Which access log lines are requests the WAF interrupted, and by which rule.
 *
 * When Coraza interrupts a request it logs "WAF rule violation detected" with
 * the client address, Host and URI (logger http.handlers.waf, which Caddy
 * writes to /logs/waf-rules.log), and the rules that matched with the same
 * transaction id (`unique_id`). It does so while handling the request, so
 * both lines are in waf-rules.log before Caddy writes the request's access
 * log line. log-parser.ts reads the access log first and waf-rules.log right
 * after, so every interrupted request it reads has its violation in hand;
 * violations whose access log line is not written yet are carried to the next
 * pass (pruneWafCorrelation bounds how long).
 */
import { extractBracketField, ruleInfoFromMessage } from '../waf-log-parser';

export const WAF_VIOLATION_MESSAGE = 'WAF rule violation detected';
/** How far apart (seconds) a violation and its access log line may be logged. */
export const WAF_MATCH_WINDOW_SEC = 60;
/** How long unmatched violations and rule ids are carried across passes. */
const CARRYOVER_SEC = 180;
const MAX_TRACKED = 50_000;

type Violation = { ts: number; uniqueId: string };

export type WafCorrelation = {
  /** `${client_ip}|${host}|${uri}` → violations not yet matched, oldest first. */
  violations: Map<string, Violation[]>;
  /** Transaction id → first specific rule that matched, with when it was seen. */
  rules: Map<string, { ruleId: number; ts: number }>;
};

export function createWafCorrelation(): WafCorrelation {
  return { violations: new Map(), rules: new Map() };
}

function violationKey(clientIp: string, host: string, uri: string): string {
  return `${clientIp}|${host}|${uri}`;
}

function size(correlation: WafCorrelation): number {
  let n = correlation.rules.size;
  for (const list of correlation.violations.values()) n += list.length;
  return n;
}

/** Adds the violations and rule matches of waf-rules.log `lines` to `into`. */
export function collectWafLogLines(lines: string[], into: WafCorrelation = createWafCorrelation()): WafCorrelation {
  for (const line of lines) {
    if (size(into) >= MAX_TRACKED) break;
    let entry: { msg?: unknown; ts?: unknown; hostname?: unknown; uri?: unknown; client_ip?: unknown; unique_id?: unknown };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== 'object' || typeof entry.msg !== 'string') continue;
    const ts = typeof entry.ts === 'number' && Number.isFinite(entry.ts) ? Math.floor(entry.ts) : Math.floor(Date.now() / 1000);
    if (entry.msg === WAF_VIOLATION_MESSAGE) {
      if (typeof entry.client_ip !== 'string' || typeof entry.uri !== 'string') continue;
      const host = typeof entry.hostname === 'string' ? entry.hostname : '';
      const uniqueId = typeof entry.unique_id === 'string' ? entry.unique_id : '';
      const key = violationKey(entry.client_ip, host, entry.uri);
      const list = into.violations.get(key) ?? [];
      list.push({ ts, uniqueId });
      into.violations.set(key, list);
      continue;
    }
    const uniqueId = extractBracketField(entry.msg, 'unique_id');
    if (!uniqueId || into.rules.has(uniqueId)) continue;
    const info = ruleInfoFromMessage(entry.msg);
    if (info?.ruleId != null && Number.isInteger(info.ruleId) && info.ruleId > 0) {
      into.rules.set(uniqueId, { ruleId: info.ruleId, ts });
    }
  }
  return into;
}

/**
 * Consumes the violation of the request an access log line describes, if the
 * WAF interrupted it, and returns the rule that matched (0 when unknown).
 */
export function consumeWafViolation(
  correlation: WafCorrelation | undefined,
  request: { clientIp: string; host: string; uri: string; ts: number }
): { ruleId: number } | null {
  if (!correlation) return null;
  const key = violationKey(request.clientIp, request.host, request.uri);
  const list = correlation.violations.get(key);
  if (!list || list.length === 0) return null;
  // The violation is logged while the request is handled, the access log line
  // when it is done: never later than the line (one second of rounding aside).
  const index = list.findIndex((v) => v.ts <= request.ts + 1 && request.ts - v.ts <= WAF_MATCH_WINDOW_SEC);
  if (index === -1) return null;
  const [violation] = list.splice(index, 1);
  if (list.length === 0) correlation.violations.delete(key);
  const ruleId = violation.uniqueId ? correlation.rules.get(violation.uniqueId)?.ruleId ?? 0 : 0;
  return { ruleId };
}

/** Drops violations and rule ids older than the carry-over window. */
export function pruneWafCorrelation(correlation: WafCorrelation, refTs: number): WafCorrelation {
  const cutoff = refTs - CARRYOVER_SEC;
  for (const [key, list] of correlation.violations) {
    const kept = list.filter((v) => v.ts >= cutoff);
    if (kept.length === 0) correlation.violations.delete(key);
    else correlation.violations.set(key, kept);
  }
  for (const [id, rule] of correlation.rules) {
    if (rule.ts < cutoff) correlation.rules.delete(id);
  }
  return correlation;
}
