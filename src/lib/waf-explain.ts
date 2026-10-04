/**
 * "Why was this request blocked": reads the Coraza audit record stored with a
 * WAF event (waf_events.raw_data, credential values already redacted by
 * waf-log-parser.ts) and lists the rules that matched, the anomaly points
 * each added, the matched variable and data, the total score against the
 * threshold, and the rule that made the decision (949110 and friends, or a
 * custom rule with its own deny). It also proposes the narrowest exclusion
 * for each rule that added to the score.
 *
 * The record is untrusted input (request data ends up in it): it is parsed
 * defensively, nothing in it is ever executed or interpreted beyond the
 * fields read here, and every suggested path or variable goes through the
 * same validation as user input (src/lib/waf-exclusions.ts).
 */
import { CRS_ANOMALY_POINTS, DEFAULT_INBOUND_ANOMALY_THRESHOLD, DEFAULT_OUTBOUND_ANOMALY_THRESHOLD } from "./waf-tuning";
import { normalizeVariable, pathError, ruleIdError, WAF_EXCLUSION_COLLECTIONS } from "./waf-exclusions";

/** A ModSecurity-format field, `[name "value"]`, its value Go-quoted. */
const RULE_MESSAGE_FIELD = /\[([A-Za-z0-9_]+) "((?:[^"\\]|\\.)*)"\]/g;
/** The disruptive-action prefix Coraza writes before a rule's msg. */
const ACTION_PREFIX = /Coraza: (Warning|Access denied|Access dropped|Access redirected|Access allowed|Custom disruptive action triggered)(?: \(phase (\d)\))?\. /;
const TOTAL_SCORE = /Total Score: (\d{1,9})/i;
const REPORTED_THRESHOLDS = /Inbound Scores:[^)]*threshold=(\d{1,9})\).*Outbound Scores:[^)]*threshold=(\d{1,9})\)/i;
const FOUND_WITHIN = " found within ";
const MAX_TEXT = 2048;
const MAX_MESSAGES = 200;

export const INBOUND_EVALUATION_RULE_IDS = [949110, 949111] as const;
export const OUTBOUND_EVALUATION_RULE_IDS = [959100, 959101] as const;
const REPORTING_RULE_ID = 980170;

/**
 * CRS rules whose logged data does not name the variable they inspect, but
 * which only ever inspect one.
 */
const KNOWN_RULE_VARIABLES: Record<number, string> = {
  911100: "REQUEST_METHOD",
  920420: "REQUEST_HEADERS:Content-Type",
};

export type WafRuleKind = "attack" | "inbound_evaluation" | "outbound_evaluation" | "reporting" | "custom";

export type WafMatchedRule = {
  ruleId: number;
  kind: WafRuleKind;
  message: string | null;
  severity: string | null;
  /** CRS paranoia level of the rule (its paranoia-level/N tag). */
  paranoiaLevel: number | null;
  /** Points the rule added to the blocking anomaly score; 0 when logged only; null for rules outside the anomaly scoring. */
  anomalyPoints: number | null;
  /** False for CRS rules above the blocking paranoia level: they log without adding to the score. */
  countedInScore: boolean;
  /** The variable that matched, e.g. ARGS:content, when the record says (or the rule only inspects one). */
  matchedVariable: string | null;
  /** The rule's logged data, e.g. "Matched Data: union select found within ARGS:q: ...". */
  matchedData: string | null;
  /** The rule took a disruptive action (deny, drop, redirect). */
  disruptive: boolean;
  phase: number | null;
  tags: string[];
};

export type WafExclusionSuggestion = {
  ruleId: number;
  /** The proxy host serving the request; null suggests a global exclusion. */
  proxyHostId: number | null;
  hostName: string | null;
  pathMatch: "exact" | null;
  path: string | null;
  variable: string | null;
  reason: string;
  /** What the exclusion does, in a sentence. */
  description: string;
};

export type WafExplanation = {
  eventId: string | null;
  blocked: boolean;
  request: {
    method: string | null;
    uri: string | null;
    host: string | null;
    clientIp: string | null;
    httpVersion: string | null;
    headers: Record<string, string[]>;
  };
  rules: WafMatchedRule[];
  /** The blocking inbound score: from the evaluation rule's message, else the sum of counted points. */
  inboundScore: number;
  inboundScoreSource: "record" | "computed";
  outboundScore: number | null;
  /** The inbound threshold: reported in the record (rule 980170) or, when it is not, the current settings. */
  inboundThreshold: number;
  outboundThreshold: number;
  thresholdSource: "record" | "settings";
  /** The rule whose disruptive action blocked the request (or would have, in detection only or log only). */
  decidingRule: { ruleId: number; message: string | null; kind: WafRuleKind; blocked: boolean } | null;
  /** A sentence for the dashboard. */
  summary: string;
  suggestions: WafExclusionSuggestion[];
};

export type WafExplainContext = {
  /** The blocking paranoia level of the settings that handled the request (default 1). */
  blockingParanoiaLevel?: number;
  inboundThreshold?: number;
  outboundThreshold?: number;
  /** The proxy host serving the request, when known. */
  proxyHost?: { id: number; name: string } | null;
  eventId?: string | null;
};

export class WafExplainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WafExplainError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, max = MAX_TEXT): string | null {
  return typeof value === "string" && value.length > 0 ? value.slice(0, max) : null;
}

/** Go's strconv.Unquote for the inside of a %q string (escapes only; quotes already removed). */
export function goUnquote(quoted: string): string {
  let out = "";
  for (let i = 0; i < quoted.length; i++) {
    const c = quoted[i];
    if (c !== "\\" || i + 1 >= quoted.length) {
      out += c;
      continue;
    }
    const kind = quoted[++i];
    const simple: Record<string, string> = { a: "\x07", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", "\\": "\\", '"': '"', "'": "'" };
    if (kind in simple) {
      out += simple[kind];
    } else if (kind === "x" || kind === "u" || kind === "U") {
      const digits = kind === "x" ? 2 : kind === "u" ? 4 : 8;
      const hex = quoted.slice(i + 1, i + 1 + digits);
      const code = /^[0-9a-fA-F]+$/.test(hex) && hex.length === digits ? parseInt(hex, 16) : NaN;
      if (Number.isFinite(code) && code <= 0x10ffff) {
        // \xNN is one byte of (possibly invalid) UTF-8; show it as that code point.
        out += String.fromCodePoint(code);
        i += digits;
      } else {
        out += `\\${kind}`;
      }
    } else if (kind >= "0" && kind <= "7") {
      const octal = quoted.slice(i, i + 3);
      if (/^[0-7]{3}$/.test(octal)) {
        out += String.fromCharCode(parseInt(octal, 8));
        i += 2;
      } else {
        out += `\\${kind}`;
      }
    } else {
      out += `\\${kind}`;
    }
  }
  return out;
}

/** The `[name "value"]` fields of a ModSecurity-format message (repeated fields, like tag, all kept). */
function messageFields(message: string): Map<string, string[]> {
  const fields = new Map<string, string[]>();
  for (const [, name, value] of message.matchAll(RULE_MESSAGE_FIELD)) {
    fields.set(name, [...(fields.get(name) ?? []), goUnquote(value)]);
  }
  return fields;
}

function first(fields: Map<string, string[]>, name: string): string | null {
  return fields.get(name)?.[0] ?? null;
}

/** The variable named in CRS logdata "Matched Data: X found within VAR: VALUE", if any. */
export function matchedVariableOf(data: string | null): string | null {
  if (!data) return null;
  const within = data.indexOf(FOUND_WITHIN);
  if (within === -1) return null;
  const after = data.slice(within + FOUND_WITHIN.length);
  const end = after.indexOf(": ");
  const name = (end === -1 ? after : after.slice(0, end)).trim();
  // Collection names are upper-case words; a key follows a colon.
  return /^[A-Z_]+(?::\S+)?$/.test(name) ? name : null;
}

function paranoiaLevelOf(tags: string[]): number | null {
  for (const tag of tags) {
    const match = /^paranoia-level\/([1-4])$/.exec(tag);
    if (match) return Number(match[1]);
  }
  return null;
}

function kindOf(ruleId: number, tags: string[]): WafRuleKind {
  if ((INBOUND_EVALUATION_RULE_IDS as readonly number[]).includes(ruleId)) return "inbound_evaluation";
  if ((OUTBOUND_EVALUATION_RULE_IDS as readonly number[]).includes(ruleId)) return "outbound_evaluation";
  if (ruleId === REPORTING_RULE_ID) return "reporting";
  const crs = tags.includes("OWASP_CRS") || (ruleId >= 900000 && ruleId <= 999999);
  return crs ? "attack" : "custom";
}

type ParsedMessage = {
  ruleId: number;
  message: string | null;
  data: string | null;
  severity: string | null;
  tags: string[];
  disruptive: boolean;
  phase: number | null;
};

/** One entry of the record's `messages`: part H (error_message) or part K (data), whichever it has. */
function parseMessage(entry: unknown): ParsedMessage | null {
  if (!isRecord(entry)) return null;
  const errorMessage = text(entry.error_message, 16_384) ?? text(entry.message, 16_384);
  const structured = isRecord(entry.data) ? entry.data : null;
  const fields = errorMessage ? messageFields(errorMessage) : new Map<string, string[]>();
  const rawId = structured && typeof structured.id === "number" ? String(structured.id) : first(fields, "id");
  if (!rawId || !/^\d{1,10}$/.test(rawId)) return null;
  const ruleId = Number(rawId);
  if (!Number.isSafeInteger(ruleId) || ruleId < 1) return null;

  const prefix = errorMessage ? ACTION_PREFIX.exec(errorMessage) : null;
  const action = prefix?.[1] ?? "Warning";
  const disruptive = action !== "Warning" && action !== "Access allowed";
  const structuredTags = structured && Array.isArray(structured.tags)
    ? structured.tags.filter((tag): tag is string => typeof tag === "string")
    : [];
  const severityValue = structured?.severity;
  const severity = typeof severityValue === "string"
    ? severityValue
    : typeof severityValue === "number"
      ? (["emergency", "alert", "critical", "error", "warning", "notice", "info", "debug"][severityValue] ?? null)
      : first(fields, "severity");
  return {
    ruleId,
    message: text(structured?.msg) ?? text(first(fields, "msg")),
    data: text(structured?.data) ?? text(first(fields, "data")),
    severity: severity && severity !== "unknown" ? severity.toLowerCase() : null,
    tags: structuredTags.length > 0 ? structuredTags : (fields.get("tag") ?? []),
    disruptive,
    phase: prefix?.[2] ? Number(prefix[2]) : null,
  };
}

/** The decoded, normalized path of a request URI, as REQUEST_FILENAME with t:normalizePath holds it; null when it cannot be one. */
export function requestPathOf(uri: string | null): string | null {
  if (!uri) return null;
  let path = uri;
  const cut = path.search(/[?#]/);
  if (cut !== -1) path = path.slice(0, cut);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) {
    try {
      path = new URL(path).pathname;
    } catch {
      return null;
    }
  }
  try {
    path = decodeURIComponent(path);
  } catch {
    return null;
  }
  if (!path.startsWith("/")) return null;
  // filepath.Clean, keeping a trailing slash as normalizePath does.
  const trailing = path.length > 1 && path.endsWith("/");
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  const clean = `/${segments.join("/")}${trailing && segments.length > 0 ? "/" : ""}`;
  return pathError(clean) === null ? clean : null;
}

/** The variable of a suggestion: a keyed collection with a key, valid as exclusion input. */
function suggestedVariable(variable: string | null): string | null {
  if (!variable || !variable.includes(":")) return null;
  const collection = variable.slice(0, variable.indexOf(":")).toUpperCase();
  if (!WAF_EXCLUSION_COLLECTIONS[collection]?.keyed) return null;
  const normalized = normalizeVariable(variable);
  return "variable" in normalized ? normalized.variable : null;
}

function describeSuggestion(suggestion: Omit<WafExclusionSuggestion, "description" | "reason">): string {
  const where = suggestion.hostName ? `on ${suggestion.hostName}` : "on every host that follows the global settings";
  const scope = [
    suggestion.path ? `for requests to ${suggestion.path}` : "for every request",
    suggestion.variable ? `in ${suggestion.variable} only` : null,
  ].filter(Boolean).join(", ");
  return `Skip rule ${suggestion.ruleId} ${where}, ${scope}. Every other rule still checks these requests.`;
}

function headersOf(value: unknown): Record<string, string[]> {
  if (!isRecord(value)) return {};
  const headers: Record<string, string[]> = {};
  for (const [name, values] of Object.entries(value).slice(0, 200)) {
    const list = Array.isArray(values) ? values : [values];
    headers[name.slice(0, 256)] = list.filter((item): item is string => typeof item === "string").map((item) => item.slice(0, MAX_TEXT));
  }
  return headers;
}

/**
 * Explains a stored audit record. Throws WafExplainError when the record is
 * not a Coraza JSON audit record.
 */
export function explainWafAuditRecord(rawData: string | null | undefined, context: WafExplainContext = {}): WafExplanation {
  if (!rawData) throw new WafExplainError("This event has no stored audit record");
  let record: unknown;
  try {
    record = JSON.parse(rawData);
  } catch {
    throw new WafExplainError("The stored audit record is not valid JSON");
  }
  if (!isRecord(record) || !isRecord(record.transaction)) {
    throw new WafExplainError("The stored audit record has no transaction");
  }
  const tx = record.transaction;
  const request = isRecord(tx.request) ? tx.request : {};
  const headers = headersOf(request.headers);
  const hostHeader = headers.host?.[0] ?? headers.Host?.[0] ?? null;

  const blockingLevel = typeof context.blockingParanoiaLevel === "number" ? context.blockingParanoiaLevel : 1;
  const parsed = (Array.isArray(record.messages) ? record.messages.slice(0, MAX_MESSAGES) : [])
    .map(parseMessage)
    .filter((message): message is ParsedMessage => message !== null);

  // Part H and part K can both list a rule; keep the first of each rule and data.
  const seen = new Set<string>();
  const rules: WafMatchedRule[] = [];
  for (const message of parsed) {
    const key = `${message.ruleId}\n${message.data ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const kind = kindOf(message.ruleId, message.tags);
    const paranoiaLevel = paranoiaLevelOf(message.tags);
    const basePoints = kind === "attack" && message.severity ? CRS_ANOMALY_POINTS[message.severity] ?? null : null;
    const countedInScore = basePoints !== null && (paranoiaLevel === null || paranoiaLevel <= blockingLevel);
    rules.push({
      ruleId: message.ruleId,
      kind,
      message: message.message,
      severity: message.severity,
      paranoiaLevel,
      anomalyPoints: basePoints === null ? null : countedInScore ? basePoints : 0,
      countedInScore,
      matchedVariable: matchedVariableOf(message.data) ?? KNOWN_RULE_VARIABLES[message.ruleId] ?? null,
      matchedData: message.data,
      disruptive: message.disruptive,
      phase: message.phase,
      tags: message.tags.slice(0, 50).map((tag) => tag.slice(0, 128)),
    });
  }

  const evaluation = rules.find((rule) => rule.kind === "inbound_evaluation");
  const recordedScore = evaluation?.message ? TOTAL_SCORE.exec(evaluation.message)?.[1] : undefined;
  const computedScore = rules.reduce((sum, rule) => sum + (rule.countedInScore ? rule.anomalyPoints ?? 0 : 0), 0);
  const outbound = rules.find((rule) => rule.kind === "outbound_evaluation");
  const outboundScore = outbound?.message ? TOTAL_SCORE.exec(outbound.message)?.[1] : undefined;

  const reported = rules.find((rule) => rule.kind === "reporting");
  const reportedThresholds = reported?.message ? REPORTED_THRESHOLDS.exec(reported.message) : null;
  const inboundThreshold = reportedThresholds
    ? Number(reportedThresholds[1])
    : context.inboundThreshold ?? DEFAULT_INBOUND_ANOMALY_THRESHOLD;
  const outboundThreshold = reportedThresholds
    ? Number(reportedThresholds[2])
    : context.outboundThreshold ?? DEFAULT_OUTBOUND_ANOMALY_THRESHOLD;

  const blocked = tx.is_interrupted === true;
  const deciding = rules.find((rule) => rule.disruptive) ?? evaluation ?? outbound ?? null;
  const inboundScore = recordedScore !== undefined ? Number(recordedScore) : computedScore;

  const summary = (() => {
    if (!deciding) {
      return blocked
        ? "The request was blocked, but the record does not say which rule decided it."
        : "Rules matched and were logged; no rule decided to block the request.";
    }
    if (deciding.kind === "inbound_evaluation") {
      return blocked
        ? `Blocked: the anomaly score reached ${inboundScore}, the limit is ${inboundThreshold}.`
        : `The anomaly score reached ${inboundScore} (limit ${inboundThreshold}), but the request was only logged.`;
    }
    if (deciding.kind === "outbound_evaluation") {
      return blocked
        ? `The response was blocked: its anomaly score reached ${outboundScore ?? "the limit"}, the limit is ${outboundThreshold}.`
        : `The response's anomaly score reached the limit of ${outboundThreshold}, but it was only logged.`;
    }
    return blocked
      ? `Blocked by rule ${deciding.ruleId}, which denies matching requests itself.`
      : `Rule ${deciding.ruleId} would deny this request, but it was only logged.`;
  })();

  const uri = text(request.uri);
  const path = requestPathOf(uri);
  const host = context.proxyHost ?? null;
  const suggestions: WafExclusionSuggestion[] = [];
  const suggested = new Set<string>();
  for (const rule of rules) {
    // Only CRS rules that added to the score: excluding a custom rule is
    // editing it, and excluding a rule that only logged changes nothing.
    if (rule.kind !== "attack" || !rule.countedInScore || ruleIdError(rule.ruleId) !== null) continue;
    const variable = suggestedVariable(rule.matchedVariable);
    const key = `${rule.ruleId}\n${variable ?? ""}`;
    if (suggested.has(key)) continue;
    suggested.add(key);
    const base = {
      ruleId: rule.ruleId,
      proxyHostId: host?.id ?? null,
      hostName: host?.name ?? null,
      pathMatch: path ? ("exact" as const) : null,
      path,
      variable,
    };
    suggestions.push({
      ...base,
      reason: context.eventId ? `Suggested from WAF event ${context.eventId}` : "Suggested from a WAF event",
      description: describeSuggestion(base),
    });
  }

  return {
    eventId: context.eventId ?? text(tx.id, 128),
    blocked,
    request: {
      method: text(request.method, 32),
      uri,
      host: hostHeader,
      clientIp: text(tx.client_ip, 64),
      httpVersion: text(request.http_version, 16) ?? text(request.protocol, 16),
      headers,
    },
    rules,
    inboundScore,
    inboundScoreSource: recordedScore !== undefined ? "record" : "computed",
    outboundScore: outboundScore !== undefined ? Number(outboundScore) : null,
    inboundThreshold,
    outboundThreshold,
    thresholdSource: reportedThresholds ? "record" : "settings",
    decidingRule: deciding
      ? { ruleId: deciding.ruleId, message: deciding.message, kind: deciding.kind, blocked: blocked && deciding.disruptive }
      : null,
    summary,
    suggestions,
  };
}
