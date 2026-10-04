// SPDX-License-Identifier: Elastic-2.0
/**
 * Virtual patching (feature "virtual_patching", Enterprise): shared types and
 * constants of the rule feed and the patches it delivers. Free of database
 * access, so client components, the publisher scripts and tests can use it.
 */

export const VIRTUAL_PATCHING_FEATURE = "virtual_patching" as const;

/** What a patch does: nothing, log matching requests, or block them with 403. */
export const VIRTUAL_PATCH_MODES = ["off", "detect", "block"] as const;
export type VirtualPatchMode = (typeof VIRTUAL_PATCH_MODES)[number];

export const VIRTUAL_PATCH_MODE_LABELS: Record<VirtualPatchMode, string> = {
  off: "Off",
  detect: "Detect",
  block: "Block",
};

export function isVirtualPatchMode(value: unknown): value is VirtualPatchMode {
  return typeof value === "string" && (VIRTUAL_PATCH_MODES as readonly string[]).includes(value);
}

export const PACK_SEVERITIES = ["critical", "high", "medium", "low"] as const;
export type PackSeverity = (typeof PACK_SEVERITIES)[number];

export const PACK_SEVERITY_LABELS: Record<PackSeverity, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
};

/** Subscription settings (feed URL, daily fetch, automatic blocking); master-local. */
export const VIRTUAL_PATCHING_SETTING_KEY = "virtual_patching";
/** The installed feed and the last fetch or import; master-local. */
export const RULE_FEED_STATE_KEY = "virtual_patching_state";
/** The patches turned on, as a sync payload carries them to replicas (stored there as synced:virtual_patches). */
export const VIRTUAL_PATCHES_SYNC_KEY = "virtual_patches";

/** Where the vendor publishes the signed feed. Mirrors can serve the same file elsewhere. */
export const DEFAULT_RULE_FEED_URL = "https://feed.ingres.si/v1/feed.json";

/** Size and count limits; a feed that exceeds any of them is refused whole. */
export const RULE_FEED_LIMITS = {
  /** Bytes of the feed document as fetched or imported. */
  feedBytes: 4 * 1024 * 1024,
  packs: 500,
  rulesPerPack: 20,
  ruleLength: 8192,
  operatorArgumentLength: 4096,
  cvesPerPack: 20,
  affectedPerPack: 10,
  referencesPerPack: 10,
  samplesPerKind: 10,
  titleLength: 200,
  summaryLength: 2000,
  textLength: 200,
  urlLength: 500,
  samplePathLength: 2000,
  sampleHeaders: 10,
  sampleHeaderValueLength: 1000,
  sampleBodyLength: 4000,
  feedUrlLength: 2048,
  /** Longest validity a feed may claim, issue to expiry. */
  maxValidityDays: 90,
  /** How far in the future an issue time may be, for clock skew. */
  clockSkewMs: 24 * 60 * 60 * 1000,
} as const;

/** A request that shows what a pack matches (positive) or lets through (negative). */
export type PackSample = {
  method: string;
  /** Path and query string as sent on the request line. */
  path: string;
  headers?: Record<string, string>;
  body?: string;
};

export type PackAffected = {
  product: string;
  versions: string;
  /** Versions that fix it, when there are any. */
  fixed?: string;
};

/** One virtual patch as the feed publishes it. */
export type RulePack = {
  /** Stable id, e.g. "ivp-2021-44228". */
  id: string;
  cves: string[];
  title: string;
  summary: string;
  affected: PackAffected[];
  severity: PackSeverity;
  publishedAt: string;
  updatedAt: string;
  references: string[];
  /** The publisher's recommendation: "off" packs start off, only "block" packs can be blocked automatically. */
  defaultMode: VirtualPatchMode;
  /** SecRule directives, one per entry; a chain continues into the next entry. */
  rules: string[];
  samples: { positive: PackSample[]; negative: PackSample[] };
  /** Shipped as an example of the format, not by the production feed. */
  example?: boolean;
};

/** The signed part of a feed. */
export type RuleFeedPayload = {
  v: 1;
  /** Id of the signing key, so keys can be rotated. */
  kid: string;
  /** Increases with every feed the publisher signs; an installed feed never goes back. */
  sequence: number;
  issuedAt: string;
  expiresAt: string;
  packs: RulePack[];
};

/** The feed document: the payload as base64url JSON and its Ed25519 signature. */
export type RuleFeedDocument = {
  v: 1;
  payload: string;
  signature: string;
};

export type VirtualPatchingSettings = {
  /** Fetch the feed every day. */
  subscribed: boolean;
  feedUrl: string;
  /** New critical patches the publisher recommends blocking start in block mode instead of detect. */
  autoBlockCritical: boolean;
};

export const DEFAULT_VIRTUAL_PATCHING_SETTINGS: VirtualPatchingSettings = {
  subscribed: false,
  feedUrl: DEFAULT_RULE_FEED_URL,
  autoBlockCritical: false,
};

export type RuleFeedSource = "fetch" | "import";

/** The feed whose packs are installed. */
export type InstalledRuleFeed = {
  kid: string;
  sequence: number;
  /** SHA-256 of the signed payload, hex. */
  digest: string;
  issuedAt: string;
  expiresAt: string;
  source: RuleFeedSource;
  installedAt: string;
  packs: number;
};

export type RuleFeedCheckOutcome = "updated" | "unchanged" | "failed";

/** The last fetch or import, successful or not. */
export type RuleFeedCheck = {
  at: string;
  source: RuleFeedSource;
  outcome: RuleFeedCheckOutcome;
  /** Why it failed; safe to show. */
  error: string | null;
  sequence: number | null;
  added: number;
  updated: number;
  withdrawn: number;
};

export type RuleFeedState = {
  installed: InstalledRuleFeed | null;
  lastCheck: RuleFeedCheck | null;
  /** The last fetch from the feed URL (successful or not), for the daily schedule. */
  lastFetchAt: string | null;
  lastFetchOk: boolean | null;
};

export const EMPTY_RULE_FEED_STATE: RuleFeedState = { installed: null, lastCheck: null, lastFetchAt: null, lastFetchOk: null };

/** A patch as the dashboard and the REST API show it. */
export type VirtualPatchView = {
  id: string;
  title: string;
  summary: string;
  cves: string[];
  severity: PackSeverity;
  affected: PackAffected[];
  references: string[];
  publishedAt: string;
  updatedAt: string;
  defaultMode: VirtualPatchMode;
  mode: VirtualPatchMode;
  modeChangedAt: string | null;
  ruleIds: number[];
  rules: string[];
  samples: { positive: PackSample[]; negative: PackSample[] };
  example: boolean;
  /** Its rules read request bodies, which Coraza only inspects with the CRS loaded or SecRequestBodyAccess On. */
  inspectsBody: boolean;
  /** No longer in the installed feed; it keeps its mode until turned off. */
  withdrawnAt: string | null;
  firstSeenAt: string;
  feedSequence: number | null;
};

export type VirtualPatchingView = {
  settings: VirtualPatchingSettings;
  feed: {
    installed: InstalledRuleFeed | null;
    /** The installed feed is past its expiry: its patches keep applying, but newer ones are needed. */
    expired: boolean;
    lastCheck: RuleFeedCheck | null;
    /** Key ids this build trusts; none means no feed can be verified yet. */
    trustedKeyIds: string[];
  };
  patches: VirtualPatchView[];
  counts: { total: number; detect: number; block: number; off: number; withdrawn: number };
  /** The license lets administrators subscribe, import and turn patches on. */
  configurable: boolean;
  /** False on a sync replica, which applies its master's patches. */
  editable: boolean;
  /** Where the patches shown come from: this node, or the master (a replica). */
  source: "local" | "master";
};

/** What the Security events page shows for a WAF event of a patch rule. */
export type VirtualPatchRuleRef = { patchId: string; title: string; cves: string[] };
