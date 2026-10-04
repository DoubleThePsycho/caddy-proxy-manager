/**
 * OWASP CRS tuning of the global WAF settings: paranoia level, the level
 * logged without blocking, the anomaly score thresholds and what happens when
 * a score reaches its threshold. Written as Coraza directives around the CRS
 * include (buildWafHandler in caddy-waf.ts).
 *
 * Every value that reaches a directive is an integer from a fixed range or
 * one of a fixed set of words, checked here on input (wafTuningError) and
 * again when the directives are built (resolveWafTuning), since stored
 * settings can come from an import, a replica sync or an older release.
 * Nothing user-written is ever interpolated.
 */

/** The OWASP Core Rule Set built into the Caddy image (coraza-coreruleset, docker/caddy/go.mod). */
export const OWASP_CRS_VERSION = "4.25";

/** OWASP CRS paranoia levels (tx.blocking_paranoia_level). */
export const PARANOIA_LEVELS = [1, 2, 3, 4] as const;
export type ParanoiaLevel = (typeof PARANOIA_LEVELS)[number];

export const DEFAULT_PARANOIA_LEVEL: ParanoiaLevel = 1;
/** CRS defaults of tx.inbound_anomaly_score_threshold and tx.outbound_anomaly_score_threshold. */
export const DEFAULT_INBOUND_ANOMALY_THRESHOLD = 5;
export const DEFAULT_OUTBOUND_ANOMALY_THRESHOLD = 4;
/**
 * Threshold range. The CRS suggests starting new installations far above the
 * default (over 100) and lowering it, so the ceiling is generous.
 */
export const MIN_ANOMALY_THRESHOLD = 1;
export const MAX_ANOMALY_THRESHOLD = 10_000;

/**
 * What happens when a request (or response) reaches its anomaly threshold:
 * "block" answers 403 (the CRS default), "log" lets it through and records
 * the event. Custom rules with their own deny still block.
 */
export const ANOMALY_ACTIONS = ["block", "log"] as const;
export type AnomalyAction = (typeof ANOMALY_ACTIONS)[number];

/**
 * The CRS rules that block on the anomaly score: inbound (949110, and 949111
 * with early blocking) and outbound (959100, 959101). With anomaly_action
 * "log" their disruptive action becomes pass. They can never be excluded: an
 * exclusion would silently turn blocking off for the whole scope.
 */
export const ANOMALY_EVALUATION_RULE_IDS = [949110, 949111, 959100, 959101] as const;

/**
 * Rule ids of the configuration SecActions, as the commented-out examples in
 * crs-setup.conf.example number them (900000 blocking paranoia level, 900001
 * detection paranoia level, 900110 thresholds). The example file leaves them
 * commented out, so they are free in the loaded rule set.
 */
export const CRS_SETUP_RULE_IDS = {
  blockingParanoiaLevel: 900000,
  detectionParanoiaLevel: 900001,
  anomalyThresholds: 900110,
} as const;

/** The tuning fields of the "waf" setting, as stored (all optional: unset is the CRS default). */
export type WafTuningSettings = {
  paranoia_level?: number;
  detection_paranoia_level?: number;
  inbound_anomaly_threshold?: number;
  outbound_anomaly_threshold?: number;
  anomaly_action?: AnomalyAction;
};

export const WAF_TUNING_KEYS = [
  "paranoia_level",
  "detection_paranoia_level",
  "inbound_anomaly_threshold",
  "outbound_anomaly_threshold",
  "anomaly_action",
] as const;

/** Effective tuning: every value in range. */
export type WafTuning = {
  paranoiaLevel: ParanoiaLevel;
  /** Rules up to this level run; those above paranoiaLevel only log. Never below paranoiaLevel. */
  detectionParanoiaLevel: ParanoiaLevel;
  inboundThreshold: number;
  outboundThreshold: number;
  anomalyAction: AnomalyAction;
};

function isIntegerIn(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

function isParanoiaLevel(value: unknown): value is ParanoiaLevel {
  return isIntegerIn(value, 1, 4);
}

/**
 * The effective tuning of stored settings. A value out of range (or of the
 * wrong type) falls back to the CRS default instead of reaching a directive.
 */
export function resolveWafTuning(settings: WafTuningSettings | null | undefined): WafTuning {
  const paranoiaLevel = isParanoiaLevel(settings?.paranoia_level) ? settings.paranoia_level : DEFAULT_PARANOIA_LEVEL;
  const detection = settings?.detection_paranoia_level;
  const detectionParanoiaLevel = isParanoiaLevel(detection) && detection >= paranoiaLevel ? detection : paranoiaLevel;
  const inbound = settings?.inbound_anomaly_threshold;
  const outbound = settings?.outbound_anomaly_threshold;
  return {
    paranoiaLevel,
    detectionParanoiaLevel,
    inboundThreshold: isIntegerIn(inbound, MIN_ANOMALY_THRESHOLD, MAX_ANOMALY_THRESHOLD)
      ? inbound
      : DEFAULT_INBOUND_ANOMALY_THRESHOLD,
    outboundThreshold: isIntegerIn(outbound, MIN_ANOMALY_THRESHOLD, MAX_ANOMALY_THRESHOLD)
      ? outbound
      : DEFAULT_OUTBOUND_ANOMALY_THRESHOLD,
    anomalyAction: settings?.anomaly_action === "log" ? "log" : "block",
  };
}

/** The CRS defaults: what a handler gets when nothing is tuned. */
export const DEFAULT_WAF_TUNING: WafTuning = resolveWafTuning(null);

/**
 * Why tuning fields of a settings object are invalid, or null when they are
 * all valid. Absent and null fields are valid (they mean the default).
 */
export function wafTuningError(value: Record<string, unknown>, prefix = "waf"): string | null {
  const present = (key: string) => value[key] !== undefined && value[key] !== null;
  if (present("paranoia_level") && !isParanoiaLevel(value.paranoia_level)) {
    return `${prefix}.paranoia_level must be an integer from 1 to 4`;
  }
  if (present("detection_paranoia_level")) {
    if (!isParanoiaLevel(value.detection_paranoia_level)) {
      return `${prefix}.detection_paranoia_level must be an integer from 1 to 4`;
    }
    const blocking = isParanoiaLevel(value.paranoia_level) ? value.paranoia_level : DEFAULT_PARANOIA_LEVEL;
    if (value.detection_paranoia_level < blocking) {
      return `${prefix}.detection_paranoia_level must not be lower than ${prefix}.paranoia_level`;
    }
  }
  for (const key of ["inbound_anomaly_threshold", "outbound_anomaly_threshold"] as const) {
    if (present(key) && !isIntegerIn(value[key], MIN_ANOMALY_THRESHOLD, MAX_ANOMALY_THRESHOLD)) {
      return `${prefix}.${key} must be an integer from ${MIN_ANOMALY_THRESHOLD} to ${MAX_ANOMALY_THRESHOLD}`;
    }
  }
  if (present("anomaly_action") && !(ANOMALY_ACTIONS as readonly unknown[]).includes(value.anomaly_action)) {
    return `${prefix}.anomaly_action must be block or log`;
  }
  return null;
}

/**
 * The stored form of tuning input: only fields that differ from the CRS
 * default are kept, so an untuned configuration stores (and generates)
 * nothing new. Call after wafTuningError.
 */
export function storedWafTuning(value: WafTuningSettings | null | undefined): WafTuningSettings {
  const tuning = resolveWafTuning(value);
  return {
    ...(tuning.paranoiaLevel !== DEFAULT_PARANOIA_LEVEL ? { paranoia_level: tuning.paranoiaLevel } : {}),
    ...(tuning.detectionParanoiaLevel > tuning.paranoiaLevel
      ? { detection_paranoia_level: tuning.detectionParanoiaLevel }
      : {}),
    ...(tuning.inboundThreshold !== DEFAULT_INBOUND_ANOMALY_THRESHOLD
      ? { inbound_anomaly_threshold: tuning.inboundThreshold }
      : {}),
    ...(tuning.outboundThreshold !== DEFAULT_OUTBOUND_ANOMALY_THRESHOLD
      ? { outbound_anomaly_threshold: tuning.outboundThreshold }
      : {}),
    ...(tuning.anomalyAction !== "block" ? { anomaly_action: tuning.anomalyAction } : {}),
  };
}

/** Directives a tuning adds around `Include @owasp_crs/*.conf`, and the rule ids they take. */
export type CrsTuningDirectives = {
  /** After crs-setup.conf.example, before the rules: sets the tx variables the CRS reads at initialization. */
  beforeRules: string[];
  /** After the rules: turns the anomaly evaluation rules' deny into pass for "log". */
  afterRules: string[];
  /** Rule ids the beforeRules SecActions take (a custom rule may not reuse them). */
  ruleIds: number[];
};

/**
 * The directives for `tuning`. Only values that differ from the CRS default
 * are written, so an untuned WAF gets exactly the directives it got before
 * tuning existed. Values are re-checked here: a number out of range would
 * otherwise reach SecLang.
 */
export function crsTuningDirectives(tuning: WafTuning): CrsTuningDirectives {
  const safe = resolveWafTuning({
    paranoia_level: tuning.paranoiaLevel,
    detection_paranoia_level: tuning.detectionParanoiaLevel,
    inbound_anomaly_threshold: tuning.inboundThreshold,
    outbound_anomaly_threshold: tuning.outboundThreshold,
    anomaly_action: tuning.anomalyAction,
  });
  const beforeRules: string[] = [];
  const ruleIds: number[] = [];
  const action = (id: number, setvars: string[]) => {
    ruleIds.push(id);
    beforeRules.push(`SecAction "id:${id},phase:1,pass,t:none,nolog,${setvars.map((setvar) => `setvar:${setvar}`).join(",")}"`);
  };
  if (safe.paranoiaLevel !== DEFAULT_PARANOIA_LEVEL) {
    action(CRS_SETUP_RULE_IDS.blockingParanoiaLevel, [`tx.blocking_paranoia_level=${safe.paranoiaLevel}`]);
  }
  if (safe.detectionParanoiaLevel > safe.paranoiaLevel) {
    action(CRS_SETUP_RULE_IDS.detectionParanoiaLevel, [`tx.detection_paranoia_level=${safe.detectionParanoiaLevel}`]);
  }
  const thresholds: string[] = [];
  if (safe.inboundThreshold !== DEFAULT_INBOUND_ANOMALY_THRESHOLD) {
    thresholds.push(`tx.inbound_anomaly_score_threshold=${safe.inboundThreshold}`);
  }
  if (safe.outboundThreshold !== DEFAULT_OUTBOUND_ANOMALY_THRESHOLD) {
    thresholds.push(`tx.outbound_anomaly_score_threshold=${safe.outboundThreshold}`);
  }
  if (thresholds.length > 0) action(CRS_SETUP_RULE_IDS.anomalyThresholds, thresholds);

  // SecRuleUpdateActionById fails the whole config when the rule is missing,
  // so it only names rules of the embedded CRS, and only after its include.
  const afterRules =
    safe.anomalyAction === "log"
      ? ANOMALY_EVALUATION_RULE_IDS.map((id) => `SecRuleUpdateActionById ${id} "pass"`)
      : [];
  return { beforeRules, afterRules, ruleIds };
}

/** Anomaly points the CRS adds per matched rule, by severity (tx.critical_anomaly_score etc.). */
export const CRS_ANOMALY_POINTS: Record<string, number> = {
  critical: 5,
  error: 4,
  warning: 3,
  notice: 2,
};
