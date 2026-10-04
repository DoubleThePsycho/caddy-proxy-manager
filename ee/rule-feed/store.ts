// SPDX-License-Identifier: Elastic-2.0
/**
 * Virtual patches at rest: the virtual_patches table (one row per pack a
 * verified feed delivered), the subscription settings and the installed feed
 * state, and what the Caddy config builder and instance sync read from them.
 *
 * Nothing here checks the license: reading and applying patches that were
 * turned on is runtime and keeps working when the license lapses. The
 * service (service.ts) gates setting up and turning on.
 *
 * On a sync replica the patches come from the master: the sync payload
 * carries the ones that are on ("virtual_patches"), stored as
 * synced:virtual_patches. Every stored rule is validated and rendered again
 * before it reaches the Caddy configuration.
 */
import { eq } from "drizzle-orm";
import { appDb, nowIso } from "@/src/lib/db";
import { virtualPatches } from "@/src/lib/db/schema";
import { getInstanceModeForSettings, getSetting, setSetting } from "@/src/lib/settings";
import type { VirtualPatchDirectives } from "@/src/lib/caddy-waf";
import { renderPackRules, validateRenderablePack } from "./seclang";
import type { VerifiedRuleFeed } from "./feed";
import {
  DEFAULT_VIRTUAL_PATCHING_SETTINGS,
  EMPTY_RULE_FEED_STATE,
  isVirtualPatchMode,
  PACK_SEVERITIES,
  RULE_FEED_LIMITS,
  RULE_FEED_STATE_KEY,
  VIRTUAL_PATCHES_SYNC_KEY,
  VIRTUAL_PATCHING_SETTING_KEY,
  type InstalledRuleFeed,
  type PackAffected,
  type PackSample,
  type PackSeverity,
  type RuleFeedCheck,
  type RuleFeedSource,
  type RuleFeedState,
  type RulePack,
  type VirtualPatchingSettings,
  type VirtualPatchMode,
  type VirtualPatchRuleRef,
  type VirtualPatchView,
} from "./types";
import { first } from "@/src/lib/db/ops";

export type VirtualPatchRow = typeof virtualPatches.$inferSelect;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(text: string | null | undefined): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

// ── Settings and state ─────────────────────────────────────────────────

/** The stored subscription settings, each field falling back to its default. */
export function parseVirtualPatchingSettings(value: unknown): VirtualPatchingSettings {
  const stored = isRecord(value) ? value : {};
  return {
    subscribed: typeof stored.subscribed === "boolean" ? stored.subscribed : DEFAULT_VIRTUAL_PATCHING_SETTINGS.subscribed,
    feedUrl:
      typeof stored.feedUrl === "string" && stored.feedUrl.startsWith("https://") && stored.feedUrl.length <= RULE_FEED_LIMITS.feedUrlLength
        ? stored.feedUrl
        : DEFAULT_VIRTUAL_PATCHING_SETTINGS.feedUrl,
    autoBlockCritical:
      typeof stored.autoBlockCritical === "boolean" ? stored.autoBlockCritical : DEFAULT_VIRTUAL_PATCHING_SETTINGS.autoBlockCritical,
  };
}

export async function readVirtualPatchingSettings(): Promise<VirtualPatchingSettings> {
  return parseVirtualPatchingSettings(await getSetting<unknown>(VIRTUAL_PATCHING_SETTING_KEY));
}

export async function writeVirtualPatchingSettings(settings: VirtualPatchingSettings): Promise<void> {
  await setSetting(VIRTUAL_PATCHING_SETTING_KEY, settings);
}

function parseInstalled(value: unknown): InstalledRuleFeed | null {
  if (!isRecord(value)) return null;
  const { kid, sequence, digest, issuedAt, expiresAt, source, installedAt, packs } = value;
  if (typeof kid !== "string" || typeof digest !== "string" || typeof issuedAt !== "string" || typeof expiresAt !== "string") return null;
  if (typeof sequence !== "number" || !Number.isSafeInteger(sequence) || typeof installedAt !== "string") return null;
  return {
    kid,
    sequence,
    digest,
    issuedAt,
    expiresAt,
    source: source === "import" ? "import" : "fetch",
    installedAt,
    packs: typeof packs === "number" ? packs : 0,
  };
}

function parseCheck(value: unknown): RuleFeedCheck | null {
  if (!isRecord(value) || typeof value.at !== "string") return null;
  const count = (field: unknown) => (typeof field === "number" && Number.isSafeInteger(field) ? field : 0);
  return {
    at: value.at,
    source: value.source === "import" ? "import" : "fetch",
    outcome: value.outcome === "updated" || value.outcome === "unchanged" ? value.outcome : "failed",
    error: typeof value.error === "string" ? value.error : null,
    sequence: typeof value.sequence === "number" ? value.sequence : null,
    added: count(value.added),
    updated: count(value.updated),
    withdrawn: count(value.withdrawn),
  };
}

export function parseRuleFeedState(value: unknown): RuleFeedState {
  if (!isRecord(value)) return { ...EMPTY_RULE_FEED_STATE };
  return {
    installed: parseInstalled(value.installed),
    lastCheck: parseCheck(value.lastCheck),
    lastFetchAt: typeof value.lastFetchAt === "string" ? value.lastFetchAt : null,
    lastFetchOk: typeof value.lastFetchOk === "boolean" ? value.lastFetchOk : null,
  };
}

export async function readRuleFeedState(): Promise<RuleFeedState> {
  return parseRuleFeedState(await getSetting<unknown>(RULE_FEED_STATE_KEY));
}

export async function writeRuleFeedState(state: RuleFeedState): Promise<void> {
  await setSetting(RULE_FEED_STATE_KEY, state);
}

// ── Rows ───────────────────────────────────────────────────────────────

export async function listPatchRows(): Promise<VirtualPatchRow[]> {
  return await appDb.select().from(virtualPatches).orderBy(virtualPatches.id);
}

export async function getPatchRow(id: string): Promise<VirtualPatchRow | undefined> {
  return await first(appDb.select().from(virtualPatches).where(eq(virtualPatches.id, id)).limit(1));
}

function parseSamples(value: unknown): { positive: PackSample[]; negative: PackSample[] } {
  const record = isRecord(value) ? value : {};
  const samples = (list: unknown) => (Array.isArray(list) ? list.filter((sample): sample is PackSample => isRecord(sample) && typeof sample.path === "string") : []);
  return { positive: samples(record.positive), negative: samples(record.negative) };
}

function parseAffected(value: unknown): PackAffected[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is Record<string, unknown> => isRecord(entry) && typeof entry.product === "string" && typeof entry.versions === "string")
    .map((entry) => ({
      product: entry.product as string,
      versions: entry.versions as string,
      ...(typeof entry.fixed === "string" ? { fixed: entry.fixed } : {}),
    }));
}

function severityOf(value: string): PackSeverity {
  return (PACK_SEVERITIES as readonly string[]).includes(value) ? (value as PackSeverity) : "medium";
}

function modeOf(value: string): VirtualPatchMode {
  return isVirtualPatchMode(value) ? value : "off";
}

/** The pack fields of a row, as renderPackRules and the validator take them. */
function packOf(row: VirtualPatchRow) {
  return { id: row.id, title: row.title, cves: stringList(parseJson(row.cves)), severity: severityOf(row.severity) };
}

/** A row as the dashboard and the REST API show it. */
export function patchView(row: VirtualPatchRow): VirtualPatchView {
  const pack = packOf(row);
  const rules = stringList(parseJson(row.rules));
  let inspectsBody = false;
  let ruleIds: number[];
  try {
    const validated = validateRenderablePack(pack, rules, `pack ${row.id}`);
    inspectsBody = validated.inspectsBody;
    ruleIds = validated.ruleIds;
  } catch {
    const stored = parseJson(row.ruleIds);
    ruleIds = Array.isArray(stored) ? stored.filter((id): id is number => typeof id === "number") : [];
  }
  return {
    id: row.id,
    title: row.title,
    summary: row.summary,
    cves: pack.cves,
    severity: pack.severity,
    affected: parseAffected(parseJson(row.affected)),
    references: stringList(parseJson(row.referenceUrls)),
    publishedAt: row.publishedAt,
    updatedAt: row.packUpdatedAt,
    defaultMode: modeOf(row.defaultMode),
    mode: modeOf(row.mode),
    modeChangedAt: row.modeChangedAt,
    ruleIds,
    rules,
    samples: parseSamples(parseJson(row.samples)),
    example: row.example,
    inspectsBody,
    withdrawnAt: row.withdrawnAt,
    firstSeenAt: row.firstSeenAt,
    feedSequence: row.feedSequence,
  };
}

/**
 * The mode a pack starts in: off when the publisher ships it off, block for a
 * critical pack the publisher recommends blocking when automatic blocking is
 * on, otherwise detect.
 */
export function initialPatchMode(pack: Pick<RulePack, "defaultMode" | "severity">, autoBlockCritical: boolean): VirtualPatchMode {
  if (pack.defaultMode === "off") return "off";
  if (autoBlockCritical && pack.severity === "critical" && pack.defaultMode === "block") return "block";
  return "detect";
}

export type InstallResult = {
  added: string[];
  updated: string[];
  withdrawn: string[];
  /** Packs that came back into the feed after being withdrawn. */
  restored: string[];
  /** New packs that start in block mode (automatic blocking). */
  autoBlocked: string[];
};

/**
 * Stores the packs of a verified feed in one transaction: new packs get their
 * initial mode, known ones keep theirs and get the new content, packs the
 * feed no longer has are marked withdrawn (and keep their mode).
 */
export async function installVerifiedPacks(
  feed: Pick<VerifiedRuleFeed, "packs" | "payload">,
  options: { autoBlockCritical: boolean; now?: string }
): Promise<InstallResult> {
  const now = options.now ?? nowIso();
  const result: InstallResult = { added: [], updated: [], withdrawn: [], restored: [], autoBlocked: [] };
  await appDb.transaction(async (tx) => {
    const existing = new Map((await tx.select().from(virtualPatches)).map((row) => [row.id, row]));
    const inFeed = new Set<string>();
    for (const { pack, validated } of feed.packs) {
      inFeed.add(pack.id);
      const content = {
        title: pack.title,
        summary: pack.summary,
        severity: pack.severity,
        cves: JSON.stringify(pack.cves),
        affected: JSON.stringify(pack.affected),
        referenceUrls: JSON.stringify(pack.references),
        rules: JSON.stringify(pack.rules),
        ruleIds: JSON.stringify(validated.ruleIds),
        samples: JSON.stringify(pack.samples),
        defaultMode: pack.defaultMode,
        example: pack.example === true,
        publishedAt: pack.publishedAt,
        packUpdatedAt: pack.updatedAt,
      };
      const row = existing.get(pack.id);
      if (!row) {
        const mode = initialPatchMode(pack, options.autoBlockCritical);
        await tx.insert(virtualPatches)
          .values({ id: pack.id, ...content, mode, modeChangedAt: now, feedSequence: feed.payload.sequence, withdrawnAt: null, firstSeenAt: now, updatedAt: now });
        result.added.push(pack.id);
        if (mode === "block") result.autoBlocked.push(pack.id);
        continue;
      }
      const changed = (Object.keys(content) as (keyof typeof content)[]).some((key) => row[key] !== content[key]);
      if (changed) result.updated.push(pack.id);
      if (row.withdrawnAt) result.restored.push(pack.id);
      await tx.update(virtualPatches)
        .set({ ...content, feedSequence: feed.payload.sequence, withdrawnAt: null, ...(changed || row.withdrawnAt ? { updatedAt: now } : {}) })
        .where(eq(virtualPatches.id, pack.id));
    }
    for (const row of existing.values()) {
      if (inFeed.has(row.id) || row.withdrawnAt) continue;
      await tx.update(virtualPatches).set({ withdrawnAt: now, updatedAt: now }).where(eq(virtualPatches.id, row.id));
      result.withdrawn.push(row.id);
    }
  });
  return result;
}

/** Every row as stored, to put back when Caddy refuses a change. */
export async function snapshotPatchRows(): Promise<VirtualPatchRow[]> {
  return await listPatchRows();
}

export async function restorePatchRows(rows: readonly VirtualPatchRow[]): Promise<void> {
  await appDb.transaction(async (tx) => {
    await tx.delete(virtualPatches);
    for (let index = 0; index < rows.length; index += 100) {
      await tx.insert(virtualPatches).values(rows.slice(index, index + 100));
    }
  });
}

export async function updatePatchMode(id: string, mode: VirtualPatchMode, now: string = nowIso()): Promise<void> {
  await appDb.update(virtualPatches).set({ mode, modeChangedAt: now, updatedAt: now }).where(eq(virtualPatches.id, id));
}

// ── What is applied ────────────────────────────────────────────────────

/** A patch that is on, as instance sync carries it and the config builder renders it. */
export type ActivePatch = {
  id: string;
  title: string;
  severity: PackSeverity;
  cves: string[];
  mode: "detect" | "block";
  rules: string[];
  withdrawn: boolean;
};

/** The value of the "virtual_patches" sync settings group. */
export type SyncedVirtualPatches = { v: 1; patches: Omit<ActivePatch, "withdrawn">[] };

const PATCH_ID = /^[a-z0-9][a-z0-9-]{2,63}$/;
const CVE_ID = /^CVE-\d{4}-\d{4,7}$/;

function activeFromRow(row: VirtualPatchRow): ActivePatch | null {
  if (row.mode !== "detect" && row.mode !== "block") return null;
  const pack = packOf(row);
  return { ...pack, mode: row.mode, rules: stringList(parseJson(row.rules)), withdrawn: row.withdrawnAt !== null };
}

/** Patches from a sync payload; entries that are not well formed are left out. */
export function parseSyncedVirtualPatches(value: unknown): ActivePatch[] {
  if (!isRecord(value) || value.v !== 1 || !Array.isArray(value.patches)) return [];
  const patches: ActivePatch[] = [];
  for (const entry of value.patches.slice(0, RULE_FEED_LIMITS.packs)) {
    if (!isRecord(entry)) continue;
    const { id, title, severity, cves, mode, rules } = entry;
    if (typeof id !== "string" || !PATCH_ID.test(id)) continue;
    if (typeof title !== "string" || title.length === 0 || title.length > RULE_FEED_LIMITS.titleLength) continue;
    if (!(PACK_SEVERITIES as readonly unknown[]).includes(severity)) continue;
    if (mode !== "detect" && mode !== "block") continue;
    const cveList = stringList(cves).filter((cve) => CVE_ID.test(cve));
    if (cveList.length === 0 || !Array.isArray(rules)) continue;
    patches.push({ id, title, severity: severity as PackSeverity, cves: cveList, mode, rules: stringList(rules), withdrawn: false });
  }
  return patches;
}

/** Whether this node applies its master's patches (a sync replica). */
export async function patchesComeFromMaster(): Promise<boolean> {
  return (await getInstanceModeForSettings()) === "slave";
}

/** The patches that are on: this node's, or the master's on a replica. Packs still in the feed first. */
export async function readActivePatches(): Promise<{ source: "local" | "master"; patches: ActivePatch[] }> {
  if (await patchesComeFromMaster()) {
    return { source: "master", patches: parseSyncedVirtualPatches(await getSetting<unknown>(`synced:${VIRTUAL_PATCHES_SYNC_KEY}`)) };
  }
  const patches = (await listPatchRows())
    .map(activeFromRow)
    .filter((patch): patch is ActivePatch => patch !== null)
    .sort((a, b) => Number(a.withdrawn) - Number(b.withdrawn) || a.id.localeCompare(b.id));
  return { source: "local", patches };
}

// A stored pack that no longer validates is logged once per content.
const warned = new Set<string>();

function warnSkipped(id: string, reason: string): void {
  const key = `${id}\n${reason}`;
  if (warned.has(key)) return;
  if (warned.size >= 1000) warned.clear();
  warned.add(key);
  console.warn(`[virtual-patches] ${id} is not applied: ${reason}`);
}

/**
 * The rendered rules of every patch that is on, for the WAF handler of each
 * host (src/lib/caddy.ts); null when none is on. A pack that fails
 * validation, or whose rule ids an earlier pack already uses, is left out
 * and logged. Never checks the license.
 */
export async function loadVirtualPatchDirectives(): Promise<VirtualPatchDirectives | null> {
  const { patches } = await readActivePatches();
  const rules: string[] = [];
  const usedIds = new Set<number>();
  for (const patch of patches) {
    let validated;
    try {
      validated = validateRenderablePack(patch, patch.rules, `pack ${patch.id}`);
    } catch (error) {
      warnSkipped(patch.id, error instanceof Error ? error.message : "it is not valid");
      continue;
    }
    const clash = validated.ruleIds.find((id) => usedIds.has(id));
    if (clash !== undefined) {
      warnSkipped(patch.id, `rule id ${clash} is already used by another patch`);
      continue;
    }
    validated.ruleIds.forEach((id) => usedIds.add(id));
    rules.push(...renderPackRules(patch, validated.rules, patch.mode));
  }
  return rules.length > 0 ? { rules } : null;
}

/** The "virtual_patches" settings group of a sync payload: the patches that are on, or null. */
export async function readVirtualPatchSyncValue(): Promise<SyncedVirtualPatches | null> {
  if (await patchesComeFromMaster()) return null;
  const { patches } = await readActivePatches();
  if (patches.length === 0) return null;
  return { v: 1, patches: patches.map(({ id, title, severity, cves, mode, rules }) => ({ id, title, severity, cves, mode, rules })) };
}

/**
 * The patch each of `ruleIds` belongs to, for WAF events: every stored pack
 * (an event may predate turning it off), or the master's on a replica.
 */
export async function findVirtualPatchRules(ruleIds: readonly number[]): Promise<Record<number, VirtualPatchRuleRef>> {
  const wanted = new Set(ruleIds);
  const found: Record<number, VirtualPatchRuleRef> = {};
  if (wanted.size === 0) return found;
  const add = (patch: { id: string; title: string; cves: string[] }, ids: readonly number[]) => {
    for (const id of ids) if (wanted.has(id)) found[id] = { patchId: patch.id, title: patch.title, cves: patch.cves };
  };
  if (await patchesComeFromMaster()) {
    for (const patch of (await readActivePatches()).patches) {
      try {
        add(patch, validateRenderablePack(patch, patch.rules, `pack ${patch.id}`).ruleIds);
      } catch {
        // Not applied either.
      }
    }
    return found;
  }
  for (const row of await listPatchRows()) {
    const stored = parseJson(row.ruleIds);
    add(packOf(row), Array.isArray(stored) ? stored.filter((id): id is number => typeof id === "number") : []);
  }
  return found;
}

/** Records a fetch or import in the feed state. */
export function recordCheck(
  state: RuleFeedState,
  check: Omit<RuleFeedCheck, "at"> & { at?: string },
  installed?: InstalledRuleFeed | null
): RuleFeedState {
  const at = check.at ?? nowIso();
  return {
    installed: installed === undefined ? state.installed : installed,
    lastCheck: { ...check, at },
    lastFetchAt: check.source === "fetch" ? at : state.lastFetchAt,
    lastFetchOk: check.source === "fetch" ? check.outcome !== "failed" : state.lastFetchOk,
  };
}

export type { RuleFeedSource };
