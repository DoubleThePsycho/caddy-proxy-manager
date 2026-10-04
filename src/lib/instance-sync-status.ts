/**
 * The slave's side of drift detection: what it records when it applies a
 * sync, and the status it reports on GET /api/instances/sync?status=1 (see
 * instance-sync-fingerprint.ts). The master compares the reported
 * fingerprint with the one of its last push.
 *
 * After a sync is applied (Caddy included) the slave stores the payload's
 * fingerprint and a digest of its own stored copy of the synced
 * configuration. The status reports the fingerprint, and whether the stored
 * copy still matches that digest: a change made on the slave itself shows as
 * local changes. Both are keyed with the sync token (on a pull replica, the
 * token derived from its pull credential, see ee/fleet/pull-config.ts); the record also holds
 * the release and a short id of the token, and a slave that was upgraded or
 * given another token since reports local changes as unknown rather than
 * guessing.
 */
import { appDb, nowIso } from "./db";
import {
  accessListEntries,
  accessListRules,
  accessLists,
  caCertificates,
  certificates,
  issuedClientCertificates,
  l4ProxyHosts,
  wafRuleExclusions,
  proxyHosts,
} from "./db/schema";
import { APP_VERSION } from "./app-version";
import { getCaddyApplyStatus } from "./caddy-apply-status";
import { getSlaveLastSync, getSyncedSetting } from "./instance-sync";
import { getSlaveFingerprintToken } from "@/ee/fleet/pull-config";
import { getSetting, setSetting } from "./settings";
import { decryptSecret, isEncryptedSecret } from "./secret";
import {
  SYNC_FINGERPRINT_SETTING_KEYS,
  SYNC_STATUS_VERSION,
  isSyncFingerprint,
  syncLocalDigest,
  syncTokenKeyId,
  type ReplicaSyncStatus,
  type SyncFingerprintContent,
} from "./instance-sync-fingerprint";

/** Settings key of the record of the last applied sync. */
export const APPLIED_SYNC_SETTING_KEY = "instance_sync_applied";

/** What applySyncPayload hands back: the fingerprint of what it stored; undefined without a sync token. */
export type AppliedSync = { fingerprint: string } | undefined;

type AppliedSyncRecord = {
  fingerprint: string;
  localDigest: string;
  keyId: string;
  appVersion: string;
  at: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Every encrypted string replaced by its plaintext; values no key here decrypts are kept as stored. */
function decryptStrings(value: unknown): unknown {
  if (typeof value === "string") {
    if (!isEncryptedSecret(value)) return value;
    try {
      return decryptSecret(value, "synced configuration digest");
    } catch {
      return value;
    }
  }
  if (Array.isArray(value)) return value.map(decryptStrings);
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decryptStrings(item)]));
  return value;
}

/** This slave's stored copy of the synced configuration, secrets decrypted, in the payload's shape. */
async function readStoredSyncContent(): Promise<SyncFingerprintContent> {
  const [certificateRows, caRows, issuedRows, listRows, entryRows, ruleRows, hostRows, l4Rows, wafExclusionRows] = await Promise.all([
    appDb.select().from(certificates).orderBy(certificates.id),
    appDb.select().from(caCertificates).orderBy(caCertificates.id),
    appDb.select().from(issuedClientCertificates).orderBy(issuedClientCertificates.id),
    appDb.select().from(accessLists).orderBy(accessLists.id),
    appDb.select().from(accessListEntries).orderBy(accessListEntries.id),
    appDb.select().from(accessListRules).orderBy(accessListRules.id),
    appDb.select().from(proxyHosts).orderBy(proxyHosts.id),
    appDb.select().from(l4ProxyHosts).orderBy(l4ProxyHosts.id),
    appDb.select().from(wafRuleExclusions).orderBy(wafRuleExclusions.id),
  ]);
  const settings: Record<string, unknown> = {};
  for (const key of SYNC_FINGERPRINT_SETTING_KEYS) {
    settings[key] = decryptStrings(await getSyncedSetting<unknown>(key));
  }
  return {
    settings,
    data: {
      certificates: certificateRows.map((row) => ({
        ...row,
        privateKeyPem: row.privateKeyPem ? (decryptStrings(row.privateKeyPem) as string) : row.privateKeyPem,
      })),
      caCertificates: caRows,
      issuedClientCertificates: issuedRows,
      accessLists: listRows,
      accessListEntries: entryRows,
      accessListRules: ruleRows,
      proxyHosts: hostRows,
      l4ProxyHosts: l4Rows,
      wafRuleExclusions: wafExclusionRows,
    },
  };
}

function readRecord(value: unknown): AppliedSyncRecord | null {
  if (!isRecord(value)) return null;
  const { fingerprint, localDigest, keyId, appVersion, at } = value;
  if (!isSyncFingerprint(fingerprint) || typeof localDigest !== "string" || typeof keyId !== "string") return null;
  if (typeof appVersion !== "string" || typeof at !== "string") return null;
  return { fingerprint, localDigest, keyId, appVersion, at };
}

/**
 * Record a sync this slave applied (after Caddy accepted it). Never throws:
 * the sync itself succeeded, and a missing record only makes the status
 * report the fingerprint as unknown.
 */
export async function recordAppliedSync(applied: AppliedSync): Promise<void> {
  if (!applied) return;
  try {
    const token = await getSlaveFingerprintToken();
    if (!token) return;
    const record: AppliedSyncRecord = {
      fingerprint: applied.fingerprint,
      localDigest: syncLocalDigest(await readStoredSyncContent(), token),
      keyId: syncTokenKeyId(token),
      appVersion: APP_VERSION,
      at: nowIso(),
    };
    await setSetting(APPLIED_SYNC_SETTING_KEY, record);
  } catch (error) {
    console.warn("Instance sync: could not record the applied configuration:", error instanceof Error ? error.name : typeof error);
  }
}

/** The settings groups this slave overrides with a value of its own (see getEffectiveSetting). */
async function overriddenSettings(): Promise<string[]> {
  const overridden: string[] = [];
  for (const key of SYNC_FINGERPRINT_SETTING_KEYS) {
    if ((await getSetting<unknown>(key)) !== null) overridden.push(key);
  }
  return overridden;
}

/** The body of GET /api/instances/sync?status=1. Holds no secrets. */
export async function buildReplicaSyncStatus(): Promise<{ syncStatus: ReplicaSyncStatus }> {
  const [stored, token, lastSync, overridden] = await Promise.all([
    getSetting<unknown>(APPLIED_SYNC_SETTING_KEY),
    getSlaveFingerprintToken(),
    getSlaveLastSync(),
    overriddenSettings(),
  ]);
  const record = readRecord(stored);
  let localChanges: boolean | null = null;
  if (record && token && record.keyId === syncTokenKeyId(token) && record.appVersion === APP_VERSION) {
    localChanges = syncLocalDigest(await readStoredSyncContent(), token) !== record.localDigest;
  }
  const caddy = await getCaddyApplyStatus();
  return {
    syncStatus: {
      version: SYNC_STATUS_VERSION,
      appVersion: APP_VERSION,
      fingerprint: record?.fingerprint ?? null,
      appliedAt: record?.at ?? null,
      localChanges,
      overriddenSettings: overridden,
      lastSync: { at: lastSync.at, error: lastSync.error },
      caddy: caddy ? { ok: caddy.ok, at: caddy.at, code: caddy.code } : null,
    },
  };
}
