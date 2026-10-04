// SPDX-License-Identifier: Elastic-2.0
/**
 * Automatic license updates: keep the installed license up to date from the
 * license server. Off by default, so air-gapped installs never call out.
 *
 * While it is on, the leader node (a standalone install or the instance sync
 * master; never a replica) asks the license server once a day, at a random
 * minute of the UTC day, for the current key of the installed license:
 * one GET with the license id in the path and the license's refresh token
 * as a bearer token. Nothing else is sent. A returned key is installed only
 * if its signature verifies with the public keys built into this release,
 * it is for the same license id, it was issued after the installed key, and
 * it could be installed by hand (not past its grace period).
 *
 * Two settings rows, both local to this install (not part of instance sync,
 * the configuration export or history): "license_auto_update" holds the
 * switch, the license id the refresh token belongs to, the token encrypted
 * with encryptSecret, and the minute of the day; "license_auto_update_state"
 * when the server was last asked and what happened. The token is never
 * returned by an API, an action or a page, never logged and never audited.
 * Turning automatic updates off deletes it.
 */
import { clearSetting, getSetting, setSetting } from "@/src/lib/settings";
import { logAuditEvent } from "@/src/lib/audit";
import { decryptSecret, encryptSecret } from "@/src/lib/secret";
import { ApiClientError, ApiConflictError, ApiValidationError } from "@/src/lib/api-errors";
import { getInstanceMode, type InstanceMode } from "@/src/lib/instance-sync";
import { isMinuteOfDay, nextDailyAttempt, randomMinuteOfDay } from "@/src/lib/usage-ping/schedule";
import { EDITION_LABELS } from "./features";
import { LicenseKeyError, verifyLicenseKey, type LicensePayload, type LicenseState } from "./license";
import { getTrustedLicenseKeys } from "./public-keys";
import { checkLicenseKey, getLicenseState, installLicenseKey } from "./store";
import { currentLicenseUrl, isLicenseAutoUpdateDisabledByEnv, resolveLicenseServer } from "./auto-update-env";
import { fetchCurrentLicenseKey, type CurrentLicenseResult } from "./auto-update-transport";

export const LICENSE_AUTO_UPDATE_SETTING_KEY = "license_auto_update";
export const LICENSE_AUTO_UPDATE_STATE_KEY = "license_auto_update_state";

/** `lrt_` and 32 random bytes in base64url, as the license server issues them. */
export const REFRESH_TOKEN_PATTERN = /^lrt_[A-Za-z0-9_-]{43}$/;
/** "Check now" runs at most this often. */
export const MANUAL_CHECK_SPACING_MS = 60_000;

export type LicenseAutoUpdateSettings = {
  enabled: boolean;
  /** The license the refresh token belongs to. */
  licenseId: string | null;
  /** encryptSecret(refresh token); never leaves this module in clear. */
  refreshToken: string | null;
  /** Minute of the UTC day the daily check runs, random, picked when it is turned on. */
  minuteOfDay: number | null;
  changedAt: string;
};

export type LicenseAutoUpdateResult = "updated" | "current" | "failed" | "revoked";

export type LicenseAutoUpdateState = {
  nextCheckAt: string | null;
  lastCheckAt: string | null;
  /** The last time the license server answered with a key (installed or not). */
  lastSuccessAt: string | null;
  lastResult: LicenseAutoUpdateResult | null;
  /** Why the last check failed, in a few words (never a response body). */
  lastError: string | null;
  /** The last time a newer key was installed. */
  lastUpdatedAt: string | null;
  lastFailureLoggedAt: string | null;
};

/**
 * on: checks run daily. license_mismatch: the installed license is not the
 * one the refresh token belongs to, so nothing is sent. no_license: no valid
 * license is installed, so there is nothing to keep up to date.
 */
export type LicenseAutoUpdateStatus =
  | "on"
  | "off"
  | "disabled_by_env"
  | "replica"
  | "invalid_endpoint"
  | "license_mismatch"
  | "no_license";

export type LicenseAutoUpdateView = {
  enabled: boolean;
  /** A refresh token is stored (it is never returned). */
  hasRefreshToken: boolean;
  /** The license the stored refresh token belongs to. */
  licenseId: string | null;
  disabledByEnv: boolean;
  role: InstanceMode;
  status: LicenseAutoUpdateStatus;
  /** The license server (LICENSE_SERVER_URL or the default). */
  endpoint: string | null;
  endpointError: string | null;
  nextCheckAt: string | null;
  lastCheckAt: string | null;
  lastSuccessAt: string | null;
  lastResult: LicenseAutoUpdateResult | null;
  lastError: string | null;
  lastUpdatedAt: string | null;
};

export type LicenseAutoUpdateInput = { enabled: boolean; refreshToken?: string };

const EMPTY_STATE: LicenseAutoUpdateState = {
  nextCheckAt: null,
  lastCheckAt: null,
  lastSuccessAt: null,
  lastResult: null,
  lastError: null,
  lastUpdatedAt: null,
  lastFailureLoggedAt: null,
};

const RESULTS: readonly LicenseAutoUpdateResult[] = ["updated", "current", "failed", "revoked"];
const MAX_LICENSE_ID_LENGTH = 64;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isoOrNull(value: unknown): string | null {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : null;
}

export function isRefreshToken(value: unknown): value is string {
  return typeof value === "string" && REFRESH_TOKEN_PATTERN.test(value);
}

/** The stored setting, or null when it was never turned on. On only with a license id, a token and a minute. */
export async function readLicenseAutoUpdateSettings(): Promise<LicenseAutoUpdateSettings | null> {
  const stored = await getSetting<unknown>(LICENSE_AUTO_UPDATE_SETTING_KEY);
  if (!isRecord(stored)) return null;
  const licenseId =
    typeof stored.licenseId === "string" && stored.licenseId.length > 0 && stored.licenseId.length <= MAX_LICENSE_ID_LENGTH
      ? stored.licenseId
      : null;
  const refreshToken = typeof stored.refreshToken === "string" && stored.refreshToken.length > 0 ? stored.refreshToken : null;
  const minuteOfDay = isMinuteOfDay(stored.minuteOfDay) ? stored.minuteOfDay : null;
  const enabled = stored.enabled === true && licenseId !== null && refreshToken !== null && minuteOfDay !== null;
  return {
    enabled,
    licenseId,
    refreshToken,
    minuteOfDay,
    changedAt: isoOrNull(stored.changedAt) ?? new Date(0).toISOString(),
  };
}

export async function readLicenseAutoUpdateState(): Promise<LicenseAutoUpdateState> {
  const stored = await getSetting<unknown>(LICENSE_AUTO_UPDATE_STATE_KEY);
  if (!isRecord(stored)) return { ...EMPTY_STATE };
  return {
    nextCheckAt: isoOrNull(stored.nextCheckAt),
    lastCheckAt: isoOrNull(stored.lastCheckAt),
    lastSuccessAt: isoOrNull(stored.lastSuccessAt),
    lastResult: RESULTS.includes(stored.lastResult as LicenseAutoUpdateResult) ? (stored.lastResult as LicenseAutoUpdateResult) : null,
    lastError: typeof stored.lastError === "string" ? stored.lastError.slice(0, 200) : null,
    lastUpdatedAt: isoOrNull(stored.lastUpdatedAt),
    lastFailureLoggedAt: isoOrNull(stored.lastFailureLoggedAt),
  };
}

export async function writeLicenseAutoUpdateState(state: LicenseAutoUpdateState): Promise<void> {
  await setSetting(LICENSE_AUTO_UPDATE_STATE_KEY, state);
}

/** The installed license, when there is one to keep up to date (valid, possibly expired). */
function installedLicense(state: LicenseState): LicensePayload | null {
  return state.status === "active" || state.status === "grace" || state.status === "expired" ? state.license : null;
}

function statusOf(
  settings: LicenseAutoUpdateSettings | null,
  role: InstanceMode,
  endpointError: string | null,
  installed: LicensePayload | null
): LicenseAutoUpdateStatus {
  if (isLicenseAutoUpdateDisabledByEnv()) return "disabled_by_env";
  if (role === "slave") return "replica";
  if (!settings?.enabled) return "off";
  if (endpointError) return "invalid_endpoint";
  if (!installed) return "no_license";
  if (installed.id !== settings.licenseId) return "license_mismatch";
  return "on";
}

/** JSON-safe; never contains the refresh token. */
export async function getLicenseAutoUpdateView(now: Date = new Date()): Promise<LicenseAutoUpdateView> {
  const [settings, state, role, license] = await Promise.all([
    readLicenseAutoUpdateSettings(),
    readLicenseAutoUpdateState(),
    getInstanceMode(),
    getLicenseState(now),
  ]);
  const endpoint = resolveLicenseServer();
  const status = statusOf(settings, role, endpoint.error, installedLicense(license));
  return {
    enabled: settings?.enabled ?? false,
    hasRefreshToken: Boolean(settings?.refreshToken),
    licenseId: settings?.licenseId ?? null,
    disabledByEnv: isLicenseAutoUpdateDisabledByEnv(),
    role,
    status,
    endpoint: endpoint.url,
    endpointError: endpoint.error,
    nextCheckAt: status === "on" ? state.nextCheckAt : null,
    lastCheckAt: state.lastCheckAt,
    lastSuccessAt: state.lastSuccessAt,
    lastResult: state.lastResult,
    lastError: state.lastError,
    lastUpdatedAt: state.lastUpdatedAt,
  };
}

/** The body of PUT /api/v1/license/auto-update: exactly `{ "enabled": boolean, "refreshToken"?: string }`. */
export function parseLicenseAutoUpdateInput(body: unknown): LicenseAutoUpdateInput {
  if (!isRecord(body)) throw new ApiValidationError("Request body must be a JSON object");
  const unknownKey = Object.keys(body).find((key) => key !== "enabled" && key !== "refreshToken");
  if (unknownKey !== undefined) throw new ApiValidationError(`Unknown field: ${unknownKey.slice(0, 64)}`);
  if (typeof body.enabled !== "boolean") throw new ApiValidationError("enabled must be true or false");
  if (body.refreshToken === undefined || body.refreshToken === null || body.refreshToken === "") {
    return { enabled: body.enabled };
  }
  if (!body.enabled) throw new ApiValidationError("refreshToken is only accepted when turning automatic updates on");
  if (typeof body.refreshToken !== "string" || !isRefreshToken(body.refreshToken.trim())) {
    throw new ApiValidationError("refreshToken must be the refresh token from the license e-mail: lrt_ followed by 43 characters");
  }
  return { enabled: true, refreshToken: body.refreshToken.trim() };
}

type CheckTrigger = "scheduled" | "manual" | "enable";

export type CheckRecord = {
  result: LicenseAutoUpdateResult;
  error: string | null;
  /** The license server answered with a key. */
  answered: boolean;
};

/**
 * What to do with the server's answer for `installed`; installs a newer key
 * and audits it. Never throws for anything the server sent.
 */
async function applyAnswer(
  answer: CurrentLicenseResult,
  installed: LicensePayload,
  actorUserId: number | null,
  trigger: CheckTrigger,
  now: Date
): Promise<CheckRecord> {
  if (answer.kind === "unauthorized") {
    return { result: "failed", error: "the license server did not accept the refresh token", answered: false };
  }
  if (answer.kind === "revoked") {
    return {
      result: "revoked",
      error: "the license server says this license was revoked; the installed key keeps working until it expires",
      answered: false,
    };
  }
  if (answer.kind === "error") return { result: "failed", error: answer.error, answered: false };

  let payload: LicensePayload;
  try {
    payload = verifyLicenseKey(answer.key, getTrustedLicenseKeys());
  } catch (error) {
    const reason = error instanceof LicenseKeyError ? error.message : "The license key is not valid";
    return { result: "failed", error: `the returned key was refused: ${reason}`, answered: true };
  }
  if (payload.id !== installed.id) {
    return { result: "failed", error: `the returned key is for license ${payload.id.slice(0, 64)}, not ${installed.id}`, answered: true };
  }
  if (Date.parse(payload.iat) <= Date.parse(installed.iat)) return { result: "current", error: null, answered: true };
  const check = checkLicenseKey(answer.key, now);
  if (!check.installable) {
    return { result: "failed", error: `the returned key was refused: ${check.error ?? "The license key is not valid"}`, answered: true };
  }

  // An administrator may have installed another key while the request was out.
  const latest = installedLicense(await getLicenseState(now));
  if (!latest || latest.id !== installed.id || latest.iat !== installed.iat) return { result: "current", error: null, answered: true };

  const state = await installLicenseKey(answer.key, now);
  const next = state.license ?? payload;
  await logAuditEvent({
    userId: actorUserId,
    action: "license_auto_updated",
    entityType: "license",
    summary: `Installed the renewed ${EDITION_LABELS[next.edition]} license ${next.id} (valid until ${next.exp.slice(0, 10)}) from the license server`,
    data: {
      licenseId: next.id,
      edition: next.edition,
      nodes: next.nodes,
      previousIssuedAt: installed.iat,
      previousExpiresAt: installed.exp,
      issuedAt: next.iat,
      expiresAt: next.exp,
      trigger,
    },
  });
  return { result: "updated", error: null, answered: true };
}

/** One request for `installed`'s current key with `token`, and what came of it. */
async function askServer(
  base: string,
  installed: LicensePayload,
  token: string,
  actorUserId: number | null,
  trigger: CheckTrigger,
  now: Date,
  fetchImpl: typeof fetch
): Promise<CheckRecord & { unauthorized: boolean }> {
  const answer = await fetchCurrentLicenseKey(currentLicenseUrl(base, installed.id), token, fetchImpl);
  const record = await applyAnswer(answer, installed, actorUserId, trigger, now);
  return { ...record, unauthorized: answer.kind === "unauthorized" };
}

function stateAfter(previous: LicenseAutoUpdateState, record: CheckRecord, now: Date, nextCheckAt: string | null): LicenseAutoUpdateState {
  return {
    ...previous,
    nextCheckAt,
    lastCheckAt: now.toISOString(),
    lastSuccessAt: record.answered ? now.toISOString() : previous.lastSuccessAt,
    lastResult: record.result,
    lastError: record.error,
    lastUpdatedAt: record.result === "updated" ? now.toISOString() : previous.lastUpdatedAt,
  };
}

function decryptToken(settings: LicenseAutoUpdateSettings): string | null {
  if (!settings.refreshToken) return null;
  try {
    const token = decryptSecret(settings.refreshToken, "license refresh token");
    return isRefreshToken(token) ? token : null;
  } catch {
    return null;
  }
}

const TOKEN_UNREADABLE = "the stored refresh token cannot be decrypted; enter it again";

export type LicenseCheckOutcome =
  | "disabled_by_env"
  | "replica"
  | "off"
  | "invalid_endpoint"
  | "no_license"
  | "license_mismatch"
  | LicenseAutoUpdateResult;

/**
 * Asks the license server once, if automatic updates are on and apply to
 * the installed license, and records the result. The scheduler (actor null)
 * and "Check now" call it; `nextCheckAt` is the next daily slot to store
 * (null keeps the current one).
 */
export async function checkLicenseServer(options: {
  actorUserId: number | null;
  trigger: Exclude<CheckTrigger, "enable">;
  now?: Date;
  fetchImpl?: typeof fetch;
  reschedule: boolean;
}): Promise<LicenseCheckOutcome> {
  const now = options.now ?? new Date();
  const fetchImpl = options.fetchImpl ?? fetch;
  if (isLicenseAutoUpdateDisabledByEnv()) return "disabled_by_env";
  if ((await getInstanceMode()) === "slave") return "replica";
  const settings = await readLicenseAutoUpdateSettings();
  if (!settings?.enabled || settings.minuteOfDay === null) return "off";
  const endpoint = resolveLicenseServer();
  if (!endpoint.url) return "invalid_endpoint";
  const installed = installedLicense(await getLicenseState(now));
  if (!installed) return "no_license";
  if (installed.id !== settings.licenseId) return "license_mismatch";

  const state = await readLicenseAutoUpdateState();
  const nextCheckAt = options.reschedule ? nextDailyAttempt(settings.minuteOfDay, now).toISOString() : state.nextCheckAt;
  const token = decryptToken(settings);
  const record: CheckRecord = token
    ? await askServer(endpoint.url, installed, token, options.actorUserId, options.trigger, now, fetchImpl)
    : { result: "failed", error: TOKEN_UNREADABLE, answered: false };

  // Turned off (or the token replaced) while the request was out: leave the new state alone.
  const after = await readLicenseAutoUpdateSettings();
  if (!after?.enabled || after.refreshToken !== settings.refreshToken) return record.result;
  await writeLicenseAutoUpdateState(stateAfter(await readLicenseAutoUpdateState(), record, now, nextCheckAt));
  return record.result;
}

/**
 * "Check now": one check outside the daily slot, for an administrator. 409
 * while automatic updates do not apply, 429 when the last check was less
 * than a minute ago.
 */
export async function checkLicenseServerNow(
  actorUserId: number,
  now: Date = new Date(),
  fetchImpl: typeof fetch = fetch
): Promise<LicenseAutoUpdateView> {
  const view = await getLicenseAutoUpdateView(now);
  switch (view.status) {
    case "disabled_by_env":
      throw new ApiConflictError("Automatic license updates are turned off on this install by LICENSE_AUTO_UPDATE_DISABLED");
    case "replica":
      throw new ApiConflictError("A replica never contacts the license server; check on the master instead");
    case "off":
      throw new ApiConflictError("Automatic license updates are off");
    case "invalid_endpoint":
      throw new ApiConflictError(view.endpointError ?? "LICENSE_SERVER_URL is not valid");
    case "no_license":
      throw new ApiConflictError("No valid license is installed");
    case "license_mismatch":
      throw new ApiConflictError(
        "The stored refresh token belongs to another license; enter the refresh token of the installed license"
      );
    case "on":
      break;
  }
  const last = view.lastCheckAt ? Date.parse(view.lastCheckAt) : NaN;
  if (!Number.isNaN(last) && now.getTime() - last < MANUAL_CHECK_SPACING_MS && now.getTime() >= last) {
    throw new ApiClientError("The license server was asked less than a minute ago; try again shortly", 429);
  }
  await checkLicenseServer({ actorUserId, trigger: "manual", now, fetchImpl, reschedule: false });
  return getLicenseAutoUpdateView(now);
}

/**
 * Turns automatic updates on or off, or replaces the refresh token.
 *
 * On: needs a valid installed license, a refresh token (or the one stored
 * for that license), and the leader node. The license server is asked at
 * once; a token it refuses is not stored (400). A server that cannot be
 * reached does not stop it: the failure shows on the License page and the
 * daily check tries again.
 * Off: deletes the token and the check history.
 */
export async function setLicenseAutoUpdate(
  input: LicenseAutoUpdateInput,
  actorUserId: number,
  now: Date = new Date(),
  fetchImpl: typeof fetch = fetch
): Promise<LicenseAutoUpdateView> {
  const current = await readLicenseAutoUpdateSettings();

  if (!input.enabled) {
    if (!current) return getLicenseAutoUpdateView(now);
    const hadToken = Boolean(current.refreshToken);
    await setSetting<LicenseAutoUpdateSettings>(LICENSE_AUTO_UPDATE_SETTING_KEY, {
      enabled: false,
      licenseId: null,
      refreshToken: null,
      minuteOfDay: null,
      changedAt: now.toISOString(),
    });
    await clearSetting(LICENSE_AUTO_UPDATE_STATE_KEY);
    if (current.enabled || hadToken) {
      await logAuditEvent({
        userId: actorUserId,
        action: "license_auto_update_disabled",
        entityType: "license",
        summary: "Turned off automatic license updates and deleted the stored refresh token",
        data: { licenseId: current.licenseId },
      });
    }
    return getLicenseAutoUpdateView(now);
  }

  if (isLicenseAutoUpdateDisabledByEnv()) {
    throw new ApiConflictError("Automatic license updates are turned off on this install by LICENSE_AUTO_UPDATE_DISABLED");
  }
  if ((await getInstanceMode()) === "slave") {
    throw new ApiConflictError("A replica never contacts the license server; turn automatic updates on on the master instead");
  }
  const endpoint = resolveLicenseServer();
  if (!endpoint.url) throw new ApiConflictError(`${endpoint.error}; automatic updates cannot be turned on`);
  const installed = installedLicense(await getLicenseState(now));
  if (!installed) {
    throw new ApiConflictError("Install a valid license key first; automatic updates keep that license up to date");
  }

  let token: string;
  let replacing = false;
  if (input.refreshToken !== undefined) {
    if (!isRefreshToken(input.refreshToken)) {
      throw new ApiValidationError("Enter the refresh token from the license e-mail: lrt_ followed by 43 characters");
    }
    token = input.refreshToken;
    const stored = current?.licenseId === installed.id && current ? decryptToken(current) : null;
    if (current?.enabled && stored === token) {
      return getLicenseAutoUpdateView(now);
    }
    replacing = Boolean(current?.enabled);
  } else {
    const stored = current?.licenseId === installed.id && current ? decryptToken(current) : null;
    if (!stored) throw new ApiValidationError("Enter the refresh token from the license e-mail");
    if (current?.enabled) return getLicenseAutoUpdateView(now);
    token = stored;
  }

  // Ask the server before storing anything: a token it refuses is not kept.
  const record = await askServer(endpoint.url, installed, token, actorUserId, "enable", now, fetchImpl);
  if (record.unauthorized) {
    throw new ApiValidationError("The license server did not accept this refresh token");
  }

  const minuteOfDay = current?.minuteOfDay ?? randomMinuteOfDay();
  await setSetting<LicenseAutoUpdateSettings>(LICENSE_AUTO_UPDATE_SETTING_KEY, {
    enabled: true,
    licenseId: installed.id,
    refreshToken: encryptSecret(token),
    minuteOfDay,
    changedAt: now.toISOString(),
  });
  const previousState = replacing ? await readLicenseAutoUpdateState() : { ...EMPTY_STATE };
  await writeLicenseAutoUpdateState(stateAfter(previousState, record, now, nextDailyAttempt(minuteOfDay, now).toISOString()));
  await logAuditEvent({
    userId: actorUserId,
    action: replacing ? "license_auto_update_token_replaced" : "license_auto_update_enabled",
    entityType: "license",
    summary: replacing
      ? `Replaced the refresh token for automatic updates of license ${installed.id}`
      : `Turned on automatic updates for license ${installed.id}`,
    data: { licenseId: installed.id, firstCheck: record.result },
  });
  return getLicenseAutoUpdateView(now);
}
