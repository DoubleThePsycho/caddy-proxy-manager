// SPDX-License-Identifier: Elastic-2.0
/**
 * What this install keeps about the online license check (online-check.ts),
 * in one settings row local to the install ("license_check"; not part of
 * instance sync, the configuration export or history):
 *
 * - statements: the latest status statement from the license server, by
 *   license id (signed, so a copy cannot be forged here);
 * - firstSeen: when each license id was first seen on this install, which
 *   starts the first days an online key works without a confirmation.
 *   Removing and reinstalling a key does not reset it;
 * - the last attempt for the installed license and what came of it.
 *
 * And, in its own row ("license_install_id"), this install's license install
 * id: 32 random bytes, base64url, created on the first online check and
 * sent with every check and deactivation. The license server keeps a license
 * active on one install at a time and binds its statements to the id's
 * SHA-256. Dashboard replicas sharing the database share it; instance sync
 * replicas never check.
 *
 * Imports nothing from the license store, which reads it.
 */
import { randomBytes } from "node:crypto";
import { getSetting, setSetting, setSettingIfAbsent } from "@/src/lib/settings";
import { installIdHash, type LicenseCheckInput } from "./license";

export const LICENSE_CHECK_SETTING_KEY = "license_check";
export const LICENSE_INSTALL_ID_SETTING_KEY = "license_install_id";
const INSTALL_ID = /^[A-Za-z0-9_-]{43}$/;

/** At most this many license ids are remembered in each map; the oldest go first. */
const MAX_REMEMBERED_LICENSES = 20;
const MAX_ID_LENGTH = 64;
const MAX_STATEMENT_LENGTH = 8192;

export type StoredLicenseCheck = {
  statements: Record<string, string>;
  firstSeen: Record<string, string>;
  /** The license the attempt fields below are about. */
  licenseId: string | null;
  lastAttemptAt: string | null;
  /** The last time the license server answered with a statement that verified. */
  lastSuccessAt: string | null;
  /** Why the last attempt failed, in a few words (never a response body); null after a success. */
  lastError: string | null;
  lastFailureLoggedAt: string | null;
};

export const EMPTY_LICENSE_CHECK: StoredLicenseCheck = {
  statements: {},
  firstSeen: {},
  licenseId: null,
  lastAttemptAt: null,
  lastSuccessAt: null,
  lastError: null,
  lastFailureLoggedAt: null,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isoOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length <= 40 && !Number.isNaN(Date.parse(value)) ? value : null;
}

function stringMap(value: unknown, valid: (entry: string) => boolean): Record<string, string> {
  if (!isRecord(value)) return {};
  const out: Record<string, string> = {};
  for (const [id, entry] of Object.entries(value)) {
    if (id.length === 0 || id.length > MAX_ID_LENGTH || typeof entry !== "string" || !valid(entry)) continue;
    out[id] = entry;
  }
  return out;
}

/** Parses the stored row; anything malformed reads as empty. */
export function parseStoredLicenseCheck(stored: unknown): StoredLicenseCheck {
  if (!isRecord(stored)) return { ...EMPTY_LICENSE_CHECK, statements: {}, firstSeen: {} };
  return {
    statements: stringMap(stored.statements, (entry) => entry.length > 0 && entry.length <= MAX_STATEMENT_LENGTH),
    firstSeen: stringMap(stored.firstSeen, (entry) => isoOrNull(entry) !== null),
    licenseId:
      typeof stored.licenseId === "string" && stored.licenseId.length > 0 && stored.licenseId.length <= MAX_ID_LENGTH
        ? stored.licenseId
        : null,
    lastAttemptAt: isoOrNull(stored.lastAttemptAt),
    lastSuccessAt: isoOrNull(stored.lastSuccessAt),
    lastError: typeof stored.lastError === "string" ? stored.lastError.slice(0, 200) : null,
    lastFailureLoggedAt: isoOrNull(stored.lastFailureLoggedAt),
  };
}

export async function readLicenseCheck(): Promise<StoredLicenseCheck> {
  return parseStoredLicenseCheck(await getSetting<unknown>(LICENSE_CHECK_SETTING_KEY));
}

export async function writeLicenseCheck(check: StoredLicenseCheck): Promise<void> {
  await setSetting(LICENSE_CHECK_SETTING_KEY, check);
}

/** A license install id as created here: 43 base64url characters. */
export function isLicenseInstallId(value: unknown): value is string {
  return typeof value === "string" && INSTALL_ID.test(value);
}

/** This install's license install id, or null before the first online check. */
export async function readLicenseInstallId(): Promise<string | null> {
  const stored = await getSetting<unknown>(LICENSE_INSTALL_ID_SETTING_KEY);
  return isLicenseInstallId(stored) ? stored : null;
}

/** This install's license install id, created once (the first writer wins when replicas race). */
export async function ensureLicenseInstallId(): Promise<string> {
  const existing = await readLicenseInstallId();
  if (existing) return existing;
  const fresh = randomBytes(32).toString("base64url");
  const stored = await setSettingIfAbsent(LICENSE_INSTALL_ID_SETTING_KEY, fresh);
  if (isLicenseInstallId(stored)) return stored;
  // A malformed row: replace it.
  await setSetting(LICENSE_INSTALL_ID_SETTING_KEY, fresh);
  return fresh;
}

/** The part evaluateLicense needs; statements count only with this install's id. */
export function toCheckInput(check: StoredLicenseCheck, installId: string | null): LicenseCheckInput {
  return { statements: check.statements, firstSeen: check.firstSeen, installHash: installId ? installIdHash(installId) : null };
}

/** Keeps `keep` and the most recent other entries, MAX_REMEMBERED_LICENSES in all, ordered by `rank`. */
function pruneMap(map: Record<string, string>, keep: string, rank: (value: string) => number): Record<string, string> {
  const ids = Object.keys(map);
  if (ids.length <= MAX_REMEMBERED_LICENSES) return map;
  const others = ids.filter((id) => id !== keep).sort((a, b) => rank(map[b]) - rank(map[a]));
  const kept = [keep, ...others].filter((id) => id in map).slice(0, MAX_REMEMBERED_LICENSES);
  return Object.fromEntries(kept.map((id) => [id, map[id]]));
}

/** `check` with `licenseId` first seen at `now`, unless it was seen before. */
export function withFirstSeen(check: StoredLicenseCheck, licenseId: string, now: Date): StoredLicenseCheck {
  if (check.firstSeen[licenseId]) return check;
  const firstSeen = pruneMap({ ...check.firstSeen, [licenseId]: now.toISOString() }, licenseId, (value) => Date.parse(value));
  return { ...check, firstSeen };
}

/** `check` with `statement` stored for `licenseId`; `rank` orders the others (by their issue time) when some must go. */
export function withStatement(
  check: StoredLicenseCheck,
  licenseId: string,
  statement: string,
  rank: (statement: string) => number
): StoredLicenseCheck {
  const statements = pruneMap({ ...check.statements, [licenseId]: statement }, licenseId, rank);
  return { ...check, statements };
}

/** `check` without a stored statement for `licenseId` (after the license was deactivated here). */
export function withoutStatement(check: StoredLicenseCheck, licenseId: string): StoredLicenseCheck {
  if (!(licenseId in check.statements)) return check;
  const statements = { ...check.statements };
  delete statements[licenseId];
  return { ...check, statements };
}

/** Records that `licenseId` was first seen now, if it was not seen before. Never throws. */
export async function recordFirstSeen(licenseId: string, now: Date = new Date()): Promise<void> {
  try {
    const check = await readLicenseCheck();
    if (check.firstSeen[licenseId]) return;
    await writeLicenseCheck(withFirstSeen(check, licenseId, now));
  } catch {
    // Read again on the next evaluation; until then the key counts as seen now.
  }
}
