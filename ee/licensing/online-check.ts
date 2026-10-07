// SPDX-License-Identifier: Elastic-2.0
/**
 * The online license check: an install with an online key (v2, bought
 * online) confirms it with the license server once a day.
 *
 * The leader node (a standalone install or the instance sync master; never
 * a replica) sends one request: POST /v1/licenses/{id}/status with
 * {"keySha256": SHA-256 of the installed key}. Nothing else about the
 * install is sent. The answer is a status statement signed by the license
 * server (license.ts); it is stored only if its signature verifies with
 * the public keys built into this release and it is about the installed
 * license.
 *
 * A confirmation counts for 14 days, so an install that cannot reach the
 * license server keeps its paid settings editable that long; a new key
 * works for FIRST_CHECK_ALLOWANCE_DAYS before its first confirmation. After
 * that, or as soon as the license server says the license was revoked (a
 * refund or a chargeback), paid settings are read-only. Traffic and the
 * paid features already set up are never affected. Offline keys (v1) are
 * never checked online: installs that must not call out use one.
 */
import { createHash } from "node:crypto";
import { logAuditEvent } from "@/src/lib/audit";
import { ApiClientError, ApiConflictError } from "@/src/lib/api-errors";
import { getInstanceMode } from "@/src/lib/instance-sync";
import { EDITION_LABELS } from "./features";
import {
  requiresOnlineCheck,
  validStatementFor,
  verifyLicenseKey,
  type LicensePayload,
  type LicenseState,
  type LicenseStatement,
} from "./license";
import { getTrustedLicenseKeys } from "./public-keys";
import { countManagedNodes, getLicenseKey, getLicenseState } from "./store";
import { licenseStatusUrl, resolveLicenseServer } from "./auto-update-env";
import { postLicenseStatus } from "./online-check-transport";
import { readLicenseCheck, withStatement, writeLicenseCheck, type StoredLicenseCheck } from "./online-check-state";
import { toLicenseView, type LicenseView } from "./view";

const HOUR_MS = 60 * 60 * 1000;
/** A confirmation older than this is renewed. */
export const ONLINE_CHECK_INTERVAL_MS = 24 * HOUR_MS;
/** After an attempt (failed or not), the next one waits at least this long. */
export const ONLINE_CHECK_RETRY_MS = HOUR_MS;
/** "Check now" runs at most this often. */
export const ONLINE_CHECK_MANUAL_SPACING_MS = 60_000;

export type OnlineCheckOutcome = "replica" | "not_required" | "confirmed" | "revoked" | "failed";

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

/** Whether the scheduler should ask the license server about `licenseId` now. */
export function isOnlineCheckDue(check: StoredLicenseCheck, licenseId: string, now: Date): boolean {
  const lastAttempt = check.licenseId === licenseId && check.lastAttemptAt ? Date.parse(check.lastAttemptAt) : NaN;
  if (!Number.isNaN(lastAttempt) && now.getTime() >= lastAttempt && now.getTime() - lastAttempt < ONLINE_CHECK_RETRY_MS) {
    return false;
  }
  const latest = validStatementFor(check.statements[licenseId], licenseId, getTrustedLicenseKeys(), now);
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
  } else if (next.status === "active" && previous?.status === "revoked") {
    await logAuditEvent({
      userId: actorUserId,
      action: "license_reinstated",
      entityType: "license",
      summary: `The license server confirms the ${edition} license ${payload.id} again`,
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

  const endpoint = resolveLicenseServer();
  let outcome: OnlineCheckOutcome = "failed";
  let error: string | null = null;
  let received: { token: string; statement: LicenseStatement } | null = null;
  if (!endpoint.url) {
    error = endpoint.error;
  } else {
    const answer = await postLicenseStatus(licenseStatusUrl(endpoint.url, payload.id), keyFingerprint(key), options.fetchImpl ?? fetch);
    if (answer.kind === "ok") {
      const statement = validStatementFor(answer.statement, payload.id, keys, now);
      if (statement) {
        received = { token: answer.statement, statement };
        outcome = statement.status === "revoked" ? "revoked" : "confirmed";
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
  const previous = validStatementFor(check.statements[payload.id], payload.id, keys, now);
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
