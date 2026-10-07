// SPDX-License-Identifier: Elastic-2.0
/**
 * The online license check: an install with an online key (v2, bought
 * online) confirms it with the license server once a day.
 *
 * The leader node (a standalone install or the instance sync master; never
 * a replica) sends one request: POST /v1/licenses/{id}/status with
 * {"keySha256": SHA-256 of the installed key, "installId": this install's
 * license install id (online-check-state.ts)}. Nothing else about the
 * install is sent. The answer is a status statement signed by the license
 * server (license.ts); it is stored only if its signature verifies with
 * the public keys built into this release, it is about the installed
 * license, and it names this install.
 *
 * A license is active on one install at a time. The license server answers
 * "in_use" when another install holds it: paid settings are then read-only
 * here. Deactivating the license on an install (deactivateLicenseHere)
 * releases it for another one; the license server also releases an install
 * that has not checked for 14 days.
 *
 * A confirmation counts for 14 days, so an install that cannot reach the
 * license server keeps its paid settings editable that long; a new key
 * works for FIRST_CHECK_ALLOWANCE_DAYS before its first confirmation. After
 * that, or as soon as the license server says the license was revoked (a
 * refund, a chargeback or a shared key), paid settings are read-only. Traffic and the
 * paid features already set up are never affected. Offline keys (v1) are
 * never checked online: installs that must not call out use one.
 */
import { createHash } from "node:crypto";
import { logAuditEvent } from "@/src/lib/audit";
import { ApiClientError, ApiConflictError } from "@/src/lib/api-errors";
import { getInstanceMode } from "@/src/lib/instance-sync";
import { EDITION_LABELS } from "./features";
import {
  installIdHash,
  requiresOnlineCheck,
  validStatementFor,
  verifyLicenseKey,
  type LicensePayload,
  type LicenseState,
  type LicenseStatement,
} from "./license";
import { getTrustedLicenseKeys } from "./public-keys";
import { countManagedNodes, getLicenseKey, getLicenseState, removeLicenseKey } from "./store";
import { licenseDeactivateUrl, licenseStatusUrl, resolveLicenseServer } from "./auto-update-env";
import { postLicenseDeactivate, postLicenseStatus } from "./online-check-transport";
import {
  ensureLicenseInstallId,
  readLicenseCheck,
  readLicenseInstallId,
  withoutStatement,
  withStatement,
  writeLicenseCheck,
  type StoredLicenseCheck,
} from "./online-check-state";
import { toLicenseView, type LicenseView } from "./view";

const HOUR_MS = 60 * 60 * 1000;
/** A confirmation older than this is renewed. */
export const ONLINE_CHECK_INTERVAL_MS = 24 * HOUR_MS;
/** After an attempt (failed or not), the next one waits at least this long. */
export const ONLINE_CHECK_RETRY_MS = HOUR_MS;
/** "Check now" runs at most this often. */
export const ONLINE_CHECK_MANUAL_SPACING_MS = 60_000;

export type OnlineCheckOutcome = "replica" | "not_required" | "confirmed" | "revoked" | "in_use" | "failed";

/** Days after which the license server releases an install that stopped checking (its rule; shown in copy). */
export const INACTIVE_RELEASE_DAYS = 14;

/** What the license server is sent: the SHA-256 of the key as stored, in lowercase hex. */
export function keyFingerprint(key: string): string {
  return createHash("sha256").update(key.trim(), "utf8").digest("hex");
}

/** The installed online key, or null (no key, an invalid one, or an offline key). */
async function installedOnlineKey(): Promise<{ key: string; payload: LicensePayload } | null> {
  const key = await getLicenseKey();
  if (!key) return null;
  try {
    const payload = verifyLicenseKey(key, getTrustedLicenseKeys());
    return requiresOnlineCheck(payload) ? { key: key.trim(), payload } : null;
  } catch {
    return null;
  }
}

function issued(statement: string, now: Date): number {
  const parts = statement.split(".");
  try {
    const iat = (JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8")) as { iat?: unknown }).iat;
    const at = typeof iat === "string" ? Date.parse(iat) : NaN;
    return Number.isNaN(at) ? 0 : Math.min(at, now.getTime());
  } catch {
    return 0;
  }
}

/**
 * Whether the scheduler should ask the license server about `licenseId` now;
 * `installHash` is installIdHash of this install's license install id (null
 * before the first check).
 */
export function isOnlineCheckDue(check: StoredLicenseCheck, licenseId: string, now: Date, installHash: string | null): boolean {
  const lastAttempt = check.licenseId === licenseId && check.lastAttemptAt ? Date.parse(check.lastAttemptAt) : NaN;
  if (!Number.isNaN(lastAttempt) && now.getTime() >= lastAttempt && now.getTime() - lastAttempt < ONLINE_CHECK_RETRY_MS) {
    return false;
  }
  const latest = validStatementFor(check.statements[licenseId], licenseId, getTrustedLicenseKeys(), now, installHash);
  if (!latest) return true;
  return now.getTime() - Date.parse(latest.iat) >= ONLINE_CHECK_INTERVAL_MS;
}

async function auditTransition(previous: LicenseStatement | null, next: LicenseStatement, payload: LicensePayload, actorUserId: number | null) {
  const edition = EDITION_LABELS[payload.edition];
  if (next.status === "revoked" && previous?.status !== "revoked") {
    console.warn(`[license] The license server reports license ${payload.id} as revoked; paid settings are read-only`);
    await logAuditEvent({
      userId: actorUserId,
      action: "license_revoked",
      entityType: "license",
      summary: `The license server reports the ${edition} license ${payload.id} as revoked; paid settings are read-only`,
      data: { licenseId: payload.id, edition: payload.edition, statementIssuedAt: next.iat },
    });
  } else if (next.status === "in_use" && previous?.status !== "in_use") {
    console.warn(`[license] The license server reports license ${payload.id} as active on another install; paid settings are read-only here`);
    await logAuditEvent({
      userId: actorUserId,
      action: "license_in_use",
      entityType: "license",
      summary: `The license server reports the ${edition} license ${payload.id} as active on another install; paid settings are read-only here`,
      data: { licenseId: payload.id, edition: payload.edition, statementIssuedAt: next.iat },
    });
  } else if (next.status === "active" && previous?.status === "revoked") {
    await logAuditEvent({
      userId: actorUserId,
      action: "license_reinstated",
      entityType: "license",
      summary: `The license server confirms the ${edition} license ${payload.id} again`,
      data: { licenseId: payload.id, edition: payload.edition, statementIssuedAt: next.iat },
    });
  } else if (next.status === "active" && previous?.status === "in_use") {
    await logAuditEvent({
      userId: actorUserId,
      action: "license_in_use_ended",
      entityType: "license",
      summary: `The license server confirms the ${edition} license ${payload.id} on this install again`,
      data: { licenseId: payload.id, edition: payload.edition, statementIssuedAt: next.iat },
    });
  }
}

/**
 * Asks the license server about the installed online key once and stores
 * the answer. Never throws for anything the server sent.
 */
export async function runOnlineLicenseCheck(
  options: { now?: Date; fetchImpl?: typeof fetch; actorUserId?: number | null } = {}
): Promise<OnlineCheckOutcome> {
  const now = options.now ?? new Date();
  if ((await getInstanceMode()) === "slave") return "replica";
  const installed = await installedOnlineKey();
  if (!installed) return "not_required";
  const { key, payload } = installed;
  const keys = getTrustedLicenseKeys();
  const installId = await ensureLicenseInstallId();
  const installHash = installIdHash(installId);

  const endpoint = resolveLicenseServer();
  let outcome: OnlineCheckOutcome = "failed";
  let error: string | null = null;
  let received: { token: string; statement: LicenseStatement } | null = null;
  if (!endpoint.url) {
    error = endpoint.error;
  } else {
    const answer = await postLicenseStatus(licenseStatusUrl(endpoint.url, payload.id), keyFingerprint(key), installId, options.fetchImpl ?? fetch);
    if (answer.kind === "ok") {
      const statement = validStatementFor(answer.statement, payload.id, keys, now, installHash);
      if (statement) {
        received = { token: answer.statement, statement };
        outcome = statement.status === "revoked" ? "revoked" : statement.status === "in_use" ? "in_use" : "confirmed";
      } else {
        error = "the license server's answer could not be verified";
      }
    } else if (answer.kind === "unknown") {
      error = "the license server does not know this license key";
    } else {
      error = answer.error;
    }
  }

  // Read again: another node, or the install of a key, may have written meanwhile.
  let check = await readLicenseCheck();
  const previous = validStatementFor(check.statements[payload.id], payload.id, keys, now, installHash);
  if (received && (!previous || Date.parse(received.statement.iat) >= Date.parse(previous.iat))) {
    check = withStatement(check, payload.id, received.token, (token) => issued(token, now));
    await auditTransition(previous, received.statement, payload, options.actorUserId ?? null);
  }
  const sameLicense = check.licenseId === payload.id;
  await writeLicenseCheck({
    ...check,
    licenseId: payload.id,
    lastAttemptAt: now.toISOString(),
    lastSuccessAt: received ? now.toISOString() : sameLicense ? check.lastSuccessAt : null,
    lastError: received ? null : error,
    lastFailureLoggedAt: sameLicense ? check.lastFailureLoggedAt : null,
  });
  return outcome;
}

/**
 * After a key was installed: an online key is checked right away (within the
 * transport's 10 seconds). A failure does not undo the install; the License
 * page shows it and the scheduler tries again within the hour.
 */
export async function afterLicenseInstalled(state: LicenseState, options: { now?: Date; fetchImpl?: typeof fetch; actorUserId?: number | null } = {}) {
  if (!state.license || !requiresOnlineCheck(state.license)) return;
  try {
    await runOnlineLicenseCheck(options);
  } catch {
    // Shown on the License page; the scheduler tries again.
  }
}

/** The license as the API and the License page show it, with the online check's last attempt. */
export async function getLicenseView(now: Date = new Date()): Promise<LicenseView> {
  const [state, nodes, check] = await Promise.all([getLicenseState(now), countManagedNodes(), readLicenseCheck()]);
  return toLicenseView(state, nodes, check);
}

/**
 * "Check now": one check outside the schedule, for an administrator. 409
 * without an online key or on a replica, 429 when the last attempt was
 * less than a minute ago.
 */
export async function checkLicenseNow(actorUserId: number, now: Date = new Date(), fetchImpl: typeof fetch = fetch): Promise<LicenseView> {
  if ((await getInstanceMode()) === "slave") {
    throw new ApiConflictError("A replica never contacts the license server; install the license on the master");
  }
  const installed = await installedOnlineKey();
  if (!installed) {
    throw new ApiConflictError(
      (await getLicenseKey()) ? "The installed key is an offline key: it is not confirmed online" : "No license key is installed"
    );
  }
  const check = await readLicenseCheck();
  const last = check.licenseId === installed.payload.id && check.lastAttemptAt ? Date.parse(check.lastAttemptAt) : NaN;
  if (!Number.isNaN(last) && now.getTime() >= last && now.getTime() - last < ONLINE_CHECK_MANUAL_SPACING_MS) {
    throw new ApiClientError("The license server was asked less than a minute ago; try again shortly", 429);
  }
  await runOnlineLicenseCheck({ now, fetchImpl, actorUserId });
  return getLicenseView(now);
}

/** The license server could not release the license; nothing was removed. The message is safe to show. */
export class LicenseReleaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LicenseReleaseError";
  }
}

/** What became of the license server's activation when a key left this install. */
export type LicenseRelease = {
  /** The license the key belonged to; null without an online key. */
  licenseId: string | null;
  /** The license server released the activation (or there was none to release). */
  released: boolean;
  /** Why it could not be released; null when it was. */
  error: string | null;
};

/**
 * Asks the license server to release the installed online key's activation
 * on this install. An install that never checked holds no activation. 404
 * (a key the server does not know) counts as released: nothing is held.
 */
async function releaseActivation(key: string, payload: LicensePayload, fetchImpl: typeof fetch): Promise<LicenseRelease> {
  const installId = await readLicenseInstallId();
  if (!installId) return { licenseId: payload.id, released: true, error: null };
  const endpoint = resolveLicenseServer();
  if (!endpoint.url) return { licenseId: payload.id, released: false, error: endpoint.error };
  const answer = await postLicenseDeactivate(licenseDeactivateUrl(endpoint.url, payload.id), keyFingerprint(key), installId, fetchImpl);
  if (answer.kind === "error") return { licenseId: payload.id, released: false, error: answer.error };
  return { licenseId: payload.id, released: true, error: null };
}

/** Removes the key and the license server's last statement about its license from this install. */
async function forgetKey(licenseId: string | null): Promise<void> {
  await removeLicenseKey();
  if (licenseId) {
    const check = await readLicenseCheck();
    const next = withoutStatement(check, licenseId);
    if (next !== check) await writeLicenseCheck(next);
  }
}

/**
 * "Deactivate on this install": releases the license on the license server,
 * then removes the key here, so another install can use the license. 409 on
 * an instance sync replica, without a key, and with an offline key (nothing
 * to release: remove it instead). When the license server cannot be reached
 * it throws LicenseReleaseError and removes nothing, unless `force`: then the key is
 * removed anyway and the license server releases the activation after
 * INACTIVE_RELEASE_DAYS without checks from here.
 */
export async function deactivateLicenseHere(
  actorUserId: number,
  options: { force?: boolean; now?: Date; fetchImpl?: typeof fetch } = {}
): Promise<LicenseView> {
  if ((await getInstanceMode()) === "slave") {
    throw new ApiConflictError("A replica never contacts the license server; deactivate the license on the master");
  }
  const installed = await installedOnlineKey();
  if (!installed) {
    throw new ApiConflictError(
      (await getLicenseKey()) ? "The installed key is an offline key: it is not activated online, remove it instead" : "No license key is installed"
    );
  }
  const { key, payload } = installed;
  const release = await releaseActivation(key, payload, options.fetchImpl ?? fetch);
  if (!release.released && !options.force) {
    throw new LicenseReleaseError(
      `The license server could not release the license (${release.error}). Try again, or remove the key anyway: ` +
        `the license server releases it after ${INACTIVE_RELEASE_DAYS} days without checks from this install.`
    );
  }
  await forgetKey(payload.id);
  await logAuditEvent({
    userId: actorUserId,
    action: release.released ? "license_deactivated" : "license_removed",
    entityType: "license",
    summary: release.released
      ? `Deactivated license ${payload.id} on this install and removed its key`
      : `Removed license ${payload.id} without releasing it on the license server (${release.error})`,
    data: { licenseId: payload.id, edition: payload.edition, released: release.released },
  });
  return getLicenseView(options.now);
}

/**
 * Removes the installed key (the License page's "Remove key" and DELETE
 * /api/v1/license). An online key is released on the license server first,
 * on a best-effort basis: a failure does not stop the removal. Returns what
 * became of the activation, for the audit log.
 */
export async function removeLicenseHere(options: { fetchImpl?: typeof fetch } = {}): Promise<LicenseRelease> {
  const installed = (await getInstanceMode()) === "slave" ? null : await installedOnlineKey();
  const release = installed
    ? await releaseActivation(installed.key, installed.payload, options.fetchImpl ?? fetch).catch(
        (): LicenseRelease => ({ licenseId: installed.payload.id, released: false, error: "the license server could not be reached" })
      )
    : { licenseId: null, released: true, error: null };
  await forgetKey(release.licenseId);
  return release;
}
