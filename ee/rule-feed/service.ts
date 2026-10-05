// SPDX-License-Identifier: Elastic-2.0
/**
 * Virtual patching (feature "virtual_patching", Enterprise): subscribing to
 * the signed rule feed, fetching it (daily or on demand), importing a feed
 * file on air-gapped installs, and turning each patch off, to detection or to
 * blocking.
 *
 * License: subscribing, changing the feed URL, turning on automatic blocking,
 * fetching on demand, importing and turning a patch on (detect or block) need
 * a license with the feature. Unsubscribing, turning automatic blocking off,
 * turning a patch off and reading never do, and neither do the daily fetch
 * of a subscription that was set up and the patches in the Caddy
 * configuration: a license never touches traffic.
 *
 * A feed is verified completely (feed.ts) before anything is stored; a feed
 * that fails any check changes nothing. When Caddy refuses the configuration
 * with the new patches, the previous patches are put back and applied again.
 *
 * A sync replica applies the patches its master turned on (instance sync)
 * and changes nothing here itself (409).
 *
 * While the feature is coming soon (FEATURE_INFO `available` false), nothing
 * that sets up or turns on works, with or without a license (requireFeature
 * answers 403), and the daily fetch never runs. Turning things off and
 * reading still work.
 */
import { applyCaddyConfig } from "@/src/lib/caddy";
import { CaddyApplyError } from "@/src/lib/caddy-apply-error";
import { withSettingsUpdateLock } from "@/src/lib/settings-update-lock";
import { logAuditEvent } from "@/src/lib/audit";
import { ApiClientError, ApiConflictError, ApiValidationError } from "@/src/lib/api-errors";
import { BRAND_NAME } from "@/src/lib/brand";
import { nowIso } from "@/src/lib/db";
import { isFeatureAvailable } from "@/ee/licensing/features";
import { isFeatureConfigurable, requireFeature } from "@/ee/licensing/store";
import { checkFeedSequence, RuleFeedError, verifyRuleFeed, type VerifiedRuleFeed } from "./feed";
import { getTrustedRuleFeedKeys } from "./public-keys";
import {
  getPatchRow,
  installVerifiedPacks,
  listPatchRows,
  patchesComeFromMaster,
  patchView,
  readActivePatches,
  readRuleFeedState,
  readVirtualPatchingSettings,
  recordCheck,
  restorePatchRows,
  snapshotPatchRows,
  updatePatchMode,
  writeRuleFeedState,
  writeVirtualPatchingSettings,
  type InstallResult,
} from "./store";
import {
  isVirtualPatchMode,
  RULE_FEED_LIMITS,
  VIRTUAL_PATCH_MODE_LABELS,
  VIRTUAL_PATCHING_FEATURE,
  type RuleFeedSource,
  type VirtualPatchingSettings,
  type VirtualPatchingView,
  type VirtualPatchMode,
  type VirtualPatchView,
} from "./types";

export const REPLICA_ERROR =
  "This instance is a sync replica: it applies the virtual patches its master turned on. Change them on the master.";

const FETCH_TIMEOUT_MS = 30_000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** After a failed daily fetch, the next attempt waits this long. */
const RETRY_AFTER_FAILURE_MS = 6 * 60 * 60 * 1000;

/** Caddy did not accept the configuration with the new patches; the previous ones were put back. Safe to show. */
export class VirtualPatchApplyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VirtualPatchApplyError";
  }
}

/** Fetching the feed from its URL failed, or the fetched feed was refused. Safe to show. */
export class RuleFeedFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuleFeedFetchError";
  }
}

async function assertEditable(): Promise<void> {
  if (await patchesComeFromMaster()) throw new ApiConflictError(REPLICA_ERROR);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ── View ───────────────────────────────────────────────────────────────

function sortPatches(patches: VirtualPatchView[]): VirtualPatchView[] {
  return patches.sort(
    (a, b) => Number(a.withdrawnAt !== null) - Number(b.withdrawnAt !== null) || b.publishedAt.localeCompare(a.publishedAt) || a.id.localeCompare(b.id)
  );
}

/** Settings, the installed feed, the last check and every patch. Readable without a license. */
export async function getVirtualPatchingView(now: Date = new Date()): Promise<VirtualPatchingView> {
  const [settings, state, configurable, fromMaster] = await Promise.all([
    readVirtualPatchingSettings(),
    readRuleFeedState(),
    isFeatureConfigurable(VIRTUAL_PATCHING_FEATURE, now),
    patchesComeFromMaster(),
  ]);
  let patches: VirtualPatchView[];
  if (fromMaster) {
    // A replica only has what it applies: the master's patches that are on.
    patches = (await readActivePatches()).patches.map((patch) => ({
      id: patch.id,
      title: patch.title,
      summary: "",
      cves: patch.cves,
      severity: patch.severity,
      affected: [],
      references: [],
      publishedAt: "",
      updatedAt: "",
      defaultMode: patch.mode,
      mode: patch.mode,
      modeChangedAt: null,
      ruleIds: [],
      rules: patch.rules,
      samples: { positive: [], negative: [] },
      example: false,
      inspectsBody: false,
      withdrawnAt: null,
      firstSeenAt: "",
      feedSequence: null,
    }));
  } else {
    patches = sortPatches((await listPatchRows()).map(patchView));
  }
  const count = (mode: VirtualPatchMode) => patches.filter((patch) => patch.mode === mode).length;
  const installed = fromMaster ? null : state.installed;
  return {
    settings,
    feed: {
      installed,
      expired: installed !== null && now.getTime() > Date.parse(installed.expiresAt),
      lastCheck: fromMaster ? null : state.lastCheck,
      trustedKeyIds: [...getTrustedRuleFeedKeys().keys()],
    },
    patches,
    counts: {
      total: patches.length,
      detect: count("detect"),
      block: count("block"),
      off: count("off"),
      withdrawn: patches.filter((patch) => patch.withdrawnAt !== null).length,
    },
    available: isFeatureAvailable(VIRTUAL_PATCHING_FEATURE),
    configurable,
    editable: !fromMaster,
    source: fromMaster ? "master" : "local",
  };
}

export async function getVirtualPatch(id: string): Promise<VirtualPatchView> {
  const view = (await getVirtualPatchingView()).patches.find((patch) => patch.id === id);
  if (!view) throw new ApiClientError("Virtual patch not found", 404);
  return view;
}

// ── Subscription ───────────────────────────────────────────────────────

/** The feed URL as stored: https only, no credentials or fragment. */
export function parseFeedUrl(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new ApiValidationError("feedUrl must be a non-empty string");
  const trimmed = value.trim();
  if (trimmed.length > RULE_FEED_LIMITS.feedUrlLength) {
    throw new ApiValidationError(`feedUrl must be at most ${RULE_FEED_LIMITS.feedUrlLength} characters`);
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new ApiValidationError("feedUrl is not a URL");
  }
  if (url.protocol !== "https:") throw new ApiValidationError("feedUrl must be an https:// URL");
  if (url.username || url.password) throw new ApiValidationError("feedUrl must not contain credentials");
  if (url.hash) throw new ApiValidationError("feedUrl must not contain a fragment (#...)");
  return url.toString();
}

/** The settings a subscription body ({subscribed?, feedUrl?, autoBlockCritical?}) asks for. */
export function parseSubscriptionInput(body: unknown, previous: VirtualPatchingSettings): VirtualPatchingSettings {
  if (!isRecord(body)) throw new ApiValidationError("The request body must be a JSON object");
  for (const key of Object.keys(body)) {
    if (!["subscribed", "feedUrl", "autoBlockCritical"].includes(key)) throw new ApiValidationError(`Unknown field: ${key.slice(0, 40)}`);
  }
  const flag = (field: "subscribed" | "autoBlockCritical") => {
    const value = body[field];
    if (value === undefined) return previous[field];
    if (typeof value !== "boolean") throw new ApiValidationError(`${field} must be true or false`);
    return value;
  };
  return {
    subscribed: flag("subscribed"),
    feedUrl: body.feedUrl === undefined ? previous.feedUrl : parseFeedUrl(body.feedUrl),
    autoBlockCritical: flag("autoBlockCritical"),
  };
}

/** Whether going from `previous` to `next` sets up or turns on something (and so needs the license). */
export function subscriptionChangeNeedsLicense(previous: VirtualPatchingSettings, next: VirtualPatchingSettings): boolean {
  return (
    (next.subscribed && !previous.subscribed) ||
    next.feedUrl !== previous.feedUrl ||
    (next.autoBlockCritical && !previous.autoBlockCritical)
  );
}

/**
 * Subscribes, changes the feed URL or automatic blocking, or unsubscribes.
 * Only turning things off works without the license.
 */
export async function updateRuleFeedSubscription(body: unknown, actorUserId: number): Promise<VirtualPatchingView> {
  await assertEditable();
  const previous = await readVirtualPatchingSettings();
  const next = parseSubscriptionInput(body, previous);
  if (JSON.stringify(previous) === JSON.stringify(next)) return getVirtualPatchingView();
  if (subscriptionChangeNeedsLicense(previous, next)) await requireFeature(VIRTUAL_PATCHING_FEATURE);
  await writeVirtualPatchingSettings(next);
  const changes = [
    previous.subscribed !== next.subscribed ? (next.subscribed ? "subscribed to the rule feed" : "unsubscribed from the rule feed") : null,
    previous.feedUrl !== next.feedUrl ? `set the feed URL to ${next.feedUrl}` : null,
    previous.autoBlockCritical !== next.autoBlockCritical
      ? `turned automatic blocking of new critical patches ${next.autoBlockCritical ? "on" : "off"}`
      : null,
  ].filter(Boolean);
  await logAuditEvent({
    userId: actorUserId,
    action: "virtual_patching_updated",
    entityType: "virtual_patching",
    summary: `Virtual patching: ${changes.join(", ")}`,
    data: { previous, next },
  });
  return getVirtualPatchingView();
}

// ── Fetch and import ───────────────────────────────────────────────────

export type RuleFeedRunResult = {
  outcome: "updated" | "unchanged";
  sequence: number;
  added: string[];
  updated: string[];
  withdrawn: string[];
  autoBlocked: string[];
};

/** Downloads the feed document; messages never echo the response. */
export async function downloadRuleFeed(url: string): Promise<string> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      redirect: "error",
      cache: "no-store",
      headers: { Accept: "application/json", "User-Agent": `${BRAND_NAME}-RuleFeed/1` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    throw new RuleFeedFetchError(
      timedOut ? `The feed URL did not answer within ${FETCH_TIMEOUT_MS / 1000} seconds` : "The feed URL could not be reached (or it redirected, which is not followed)"
    );
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new RuleFeedFetchError(`The feed URL answered with HTTP ${response.status}`);
  }
  const limit = RULE_FEED_LIMITS.feedBytes;
  const tooLarge = `The feed is larger than ${limit / (1024 * 1024)} MiB`;
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel().catch(() => undefined);
    throw new RuleFeedFetchError(tooLarge);
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel().catch(() => undefined);
        throw new RuleFeedFetchError(tooLarge);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof RuleFeedFetchError) throw error;
    throw new RuleFeedFetchError("The feed download was interrupted");
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Applies the configuration; when Caddy refuses it, puts the rows back, re-applies and throws. */
async function applyOrRestore(snapshot: Awaited<ReturnType<typeof snapshotPatchRows>>, what: string): Promise<void> {
  try {
    await applyCaddyConfig();
  } catch (error) {
    // Caddy took the configuration; only pushing it to slaves failed, and the next sync retries.
    if (error instanceof CaddyApplyError && error.code === "INSTANCE_SYNC_FAILED") return;
    await restorePatchRows(snapshot);
    try {
      await applyCaddyConfig();
    } catch {
      // The database holds the previous patches again; the Caddy monitor and the next change re-apply them.
    }
    const reason = error instanceof CaddyApplyError ? error.message : "building the Caddy configuration failed";
    throw new VirtualPatchApplyError(`Caddy did not accept ${what} (${reason}). The previous patches were put back.`);
  }
}

function changedSomething(result: InstallResult): boolean {
  return result.added.length + result.updated.length + result.withdrawn.length + result.restored.length > 0;
}

function describeRun(sequence: number, result: InstallResult): string {
  const parts = [
    `${result.added.length} new`,
    `${result.updated.length} updated`,
    `${result.withdrawn.length} withdrawn`,
    ...(result.autoBlocked.length > 0 ? [`${result.autoBlocked.length} blocking automatically`] : []),
  ];
  return `Installed rule feed sequence ${sequence} (${parts.join(", ")})`;
}

/**
 * Verifies a feed document and installs its packs. Throws RuleFeedError when
 * the feed is refused (nothing changes), VirtualPatchApplyError when Caddy
 * refuses the result (the previous patches are put back). The outcome is
 * recorded in the feed state either way.
 */
async function installDocument(
  document: string,
  source: RuleFeedSource,
  actorUserId: number | null,
  now: Date
): Promise<RuleFeedRunResult> {
  return withSettingsUpdateLock(async () => {
    const [state, settings] = await Promise.all([readRuleFeedState(), readVirtualPatchingSettings()]);
    const fail = async (error: unknown) => {
      const message = error instanceof RuleFeedError || error instanceof VirtualPatchApplyError ? error.message : "The feed could not be installed";
      await writeRuleFeedState(
        recordCheck(state, { at: now.toISOString(), source, outcome: "failed", error: message, sequence: null, added: 0, updated: 0, withdrawn: 0 })
      );
      if (error instanceof RuleFeedError) {
        await logAuditEvent({
          userId: actorUserId,
          action: "virtual_patch_feed_refused",
          entityType: "virtual_patching",
          summary: `Refused a rule feed (${source === "import" ? "imported file" : "fetched"}): ${message}`,
          data: { source, error: message },
        });
      }
    };

    let feed: VerifiedRuleFeed;
    let ordering: "newer" | "same";
    try {
      feed = verifyRuleFeed(document, getTrustedRuleFeedKeys(), now);
      ordering = checkFeedSequence(feed, state.installed);
    } catch (error) {
      await fail(error);
      throw error;
    }
    const { sequence } = feed.payload;
    if (ordering === "same") {
      await writeRuleFeedState(
        recordCheck(state, { at: now.toISOString(), source, outcome: "unchanged", error: null, sequence, added: 0, updated: 0, withdrawn: 0 })
      );
      return { outcome: "unchanged", sequence, added: [], updated: [], withdrawn: [], autoBlocked: [] };
    }

    const snapshot = await snapshotPatchRows();
    const result = await installVerifiedPacks(feed, { autoBlockCritical: settings.autoBlockCritical, now: now.toISOString() });
    if (changedSomething(result)) {
      try {
        await applyOrRestore(snapshot, `the patches of feed sequence ${sequence}`);
      } catch (error) {
        await fail(error);
        throw error;
      }
    }
    const installed = {
      kid: feed.payload.kid,
      sequence,
      digest: feed.digest,
      issuedAt: feed.payload.issuedAt,
      expiresAt: feed.payload.expiresAt,
      source,
      installedAt: now.toISOString(),
      packs: feed.payload.packs.length,
    };
    await writeRuleFeedState(
      recordCheck(
        state,
        {
          at: now.toISOString(),
          source,
          outcome: "updated",
          error: null,
          sequence,
          added: result.added.length,
          updated: result.updated.length,
          withdrawn: result.withdrawn.length,
        },
        installed
      )
    );
    await logAuditEvent({
      userId: actorUserId,
      action: "virtual_patch_feed_installed",
      entityType: "virtual_patching",
      summary: describeRun(sequence, result),
      data: { source, kid: feed.payload.kid, sequence, issuedAt: feed.payload.issuedAt, expiresAt: feed.payload.expiresAt, ...result },
    });
    return { outcome: "updated", sequence, added: result.added, updated: result.updated, withdrawn: result.withdrawn, autoBlocked: result.autoBlocked };
  });
}

async function fetchAndInstall(actorUserId: number | null, now: Date): Promise<RuleFeedRunResult> {
  const settings = await readVirtualPatchingSettings();
  let document: string;
  try {
    document = await downloadRuleFeed(settings.feedUrl);
  } catch (error) {
    const message = error instanceof RuleFeedFetchError ? error.message : "The feed could not be fetched";
    const state = await readRuleFeedState();
    await writeRuleFeedState(
      recordCheck(state, { at: now.toISOString(), source: "fetch", outcome: "failed", error: message, sequence: null, added: 0, updated: 0, withdrawn: 0 })
    );
    throw new RuleFeedFetchError(message);
  }
  try {
    return await installDocument(document, "fetch", actorUserId, now);
  } catch (error) {
    if (error instanceof RuleFeedError) throw new RuleFeedFetchError(`The fetched feed was refused: ${error.message}`);
    throw error;
  }
}

/** Fetches the feed from the configured URL now. Needs the license. */
export async function fetchRuleFeedNow(actorUserId: number, now: Date = new Date()): Promise<RuleFeedRunResult> {
  await assertEditable();
  await requireFeature(VIRTUAL_PATCHING_FEATURE, now);
  return fetchAndInstall(actorUserId, now);
}

/** Installs a feed file (air-gapped installs), verified exactly like a fetched one. Needs the license. */
export async function importRuleFeed(document: unknown, actorUserId: number, now: Date = new Date()): Promise<RuleFeedRunResult> {
  await assertEditable();
  await requireFeature(VIRTUAL_PATCHING_FEATURE, now);
  if (typeof document !== "string" || document.trim().length === 0) throw new ApiValidationError("The feed file is empty");
  try {
    return await installDocument(document, "import", actorUserId, now);
  } catch (error) {
    if (error instanceof RuleFeedError) throw new ApiValidationError(error.message);
    throw error;
  }
}

/** Whether the daily fetch is due: a day after a successful one, six hours after a failed one. */
export function isFetchDue(state: { lastFetchAt: string | null; lastFetchOk: boolean | null }, now: Date): boolean {
  if (!state.lastFetchAt) return true;
  const last = Date.parse(state.lastFetchAt);
  if (Number.isNaN(last)) return true;
  return now.getTime() - last >= (state.lastFetchOk ? DAY_MS : RETRY_AFTER_FAILURE_MS);
}

/**
 * The daily fetch of a subscribed install (scheduler.ts). Runtime: it never
 * checks the license. Null when there is nothing to do (virtual patching is
 * coming soon, not subscribed, not due, or a replica).
 */
export async function runScheduledRuleFeedFetch(now: Date = new Date()): Promise<RuleFeedRunResult | null> {
  if (!isFeatureAvailable(VIRTUAL_PATCHING_FEATURE)) return null;
  if (await patchesComeFromMaster()) return null;
  const settings = await readVirtualPatchingSettings();
  if (!settings.subscribed) return null;
  if (!isFetchDue(await readRuleFeedState(), now)) return null;
  return fetchAndInstall(null, now);
}

// ── Patch modes ────────────────────────────────────────────────────────

/**
 * Turns a patch off, to detection or to blocking. Turning it on (detect or
 * block) needs the license; turning it off never does.
 */
export async function setVirtualPatchMode(id: string, body: unknown, actorUserId: number, now: Date = new Date()): Promise<VirtualPatchView> {
  await assertEditable();
  const mode = isRecord(body) ? body.mode : undefined;
  if (isRecord(body)) {
    for (const key of Object.keys(body)) if (key !== "mode") throw new ApiValidationError(`Unknown field: ${key.slice(0, 40)}`);
  }
  if (!isVirtualPatchMode(mode)) throw new ApiValidationError("mode must be off, detect or block");
  if (mode !== "off") await requireFeature(VIRTUAL_PATCHING_FEATURE, now);
  return withSettingsUpdateLock(async () => {
    const row = await getPatchRow(id);
    if (!row) throw new ApiClientError("Virtual patch not found", 404);
    if (row.mode === mode) return patchView(row);
    const snapshot = await snapshotPatchRows();
    await updatePatchMode(id, mode, nowIso());
    const view = patchView((await getPatchRow(id))!);
    await applyOrRestore(snapshot, `virtual patch ${view.cves[0] ?? id} in ${VIRTUAL_PATCH_MODE_LABELS[mode].toLowerCase()} mode`);
    await logAuditEvent({
      userId: actorUserId,
      action: "virtual_patch_mode_changed",
      entityType: "virtual_patch",
      summary: `Set virtual patch ${view.cves.join(", ")} (${view.title}) from ${VIRTUAL_PATCH_MODE_LABELS[row.mode as VirtualPatchMode] ?? row.mode} to ${VIRTUAL_PATCH_MODE_LABELS[mode]}`,
      data: { id, cves: view.cves, previousMode: row.mode, mode },
    });
    return view;
  });
}
