/**
 * The usage ping setting: asked once, sent only after a yes.
 *
 * Until someone answers, nothing is sent and administrators see the question
 * on the overview page, with both answers offered alike. The answer comes
 * from an administrator (the question, Settings or the REST API) or, for
 * installs nobody signs in to, from USAGE_PING_ENABLED at start-up.
 * USAGE_PING_DISABLED forbids it whatever the answer. Turning it off deletes
 * the install id here and asks the receiving service to delete what it
 * stored for it.
 *
 * Two settings rows, both local to this install: "usage_ping" holds the
 * answer (and, while it is on, the random install id and the minute of the
 * day the ping goes out), "usage_ping_state" when the ping last went out,
 * when it is due next and any erasure request still to deliver. Neither is
 * part of instance sync, the configuration export or history, so a replica,
 * a restored export or a second install never inherits the install id.
 */
import { randomUUID } from "node:crypto";
import { clearSetting, getSetting, setSetting } from "@/src/lib/settings";
import { logAuditEvent } from "@/src/lib/audit";
import { ApiConflictError, ApiValidationError } from "@/src/lib/api-errors";
import { getInstanceMode, type InstanceMode } from "@/src/lib/instance-sync";
import { buildUsagePingPayload, isUuidV4, type UsagePingPayload } from "./payload";
import { collectUsagePingFacts } from "./collect";
import { isUsagePingDisabledByEnv, isUsagePingEnabledByEnv, resolveUsagePingEndpoint } from "./env";
import { firstAttemptAfterOptIn, isMinuteOfDay, nextDailyAttempt, randomMinuteOfDay } from "./schedule";
import { sendUsagePingErasure, type UsagePingSendResult } from "./transport";

export const USAGE_PING_SETTING_KEY = "usage_ping";
export const USAGE_PING_STATE_KEY = "usage_ping_state";

/** Shown instead of the install id in the preview until one exists. */
export const PREVIEW_INSTALL_ID = "(a random id, created when the ping is turned on)";

/** An erasure request that could not be delivered is tried again this often, this many times. */
export const ERASURE_RETRY_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const ERASURE_MAX_ATTEMPTS = 28;
const MAX_PENDING_ERASURES = 5;

/** Who gave the stored answer: an administrator, or USAGE_PING_ENABLED at start-up. */
export type UsagePingAnsweredBy = "administrator" | "environment";

export type UsagePingSettings = {
  enabled: boolean;
  /** Random UUID v4 created when the ping is turned on; null while off. */
  installId: string | null;
  /** Minute of the UTC day the daily ping goes out, random, picked when it is turned on. */
  minuteOfDay: number | null;
  /** When the question was last answered. */
  answeredAt: string;
  answeredBy: UsagePingAnsweredBy;
};

export type PendingErasure = { installId: string; attempts: number; nextAttemptAt: string };

export type UsagePingState = {
  nextAttemptAt: string | null;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastResult: "sent" | "failed" | null;
  /** Why the last attempt failed, in a few words (never a response body). */
  lastError: string | null;
  lastFailureLoggedAt: string | null;
  /** Install ids whose erasure request has not been delivered yet. */
  pendingErasures: PendingErasure[];
};

/** unanswered: nobody has answered the question yet, so nothing is sent. */
export type UsagePingStatus = "on" | "unanswered" | "off" | "disabled_by_env" | "replica" | "invalid_endpoint";

export type UsagePingView = {
  /** The stored answer; false while unanswered. */
  enabled: boolean;
  /** The question has been answered; the overview question is not shown again. */
  answered: boolean;
  answeredAt: string | null;
  answeredBy: UsagePingAnsweredBy | null;
  disabledByEnv: boolean;
  role: InstanceMode;
  /** Whether pings go out now, and if not, why. */
  status: UsagePingStatus;
  endpoint: string | null;
  endpointError: string | null;
  installId: string | null;
  nextAttemptAt: string | null;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastResult: "sent" | "failed" | null;
  lastError: string | null;
  /** Erasure requests for earlier install ids still waiting to be delivered. */
  pendingErasures: number;
  /**
   * Exactly what the next ping sends, built by the code that sends it (with
   * PREVIEW_INSTALL_ID while there is no id). Null on a replica, which never sends.
   */
  payload: UsagePingPayload | null;
};

const EMPTY_STATE: UsagePingState = {
  nextAttemptAt: null,
  lastAttemptAt: null,
  lastSuccessAt: null,
  lastResult: null,
  lastError: null,
  lastFailureLoggedAt: null,
  pendingErasures: [],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isoOrNull(value: unknown): string | null {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : null;
}

/**
 * The stored answer, or null while the question is unanswered. A row without
 * a valid answeredAt counts as unanswered, so it can never send; an answer
 * is on only with a valid id and minute.
 */
export async function readUsagePingSettings(): Promise<UsagePingSettings | null> {
  const stored = await getSetting<unknown>(USAGE_PING_SETTING_KEY);
  if (!isRecord(stored)) return null;
  const answeredAt = isoOrNull(stored.answeredAt);
  if (answeredAt === null) return null;
  const enabled = stored.enabled === true && isUuidV4(stored.installId) && isMinuteOfDay(stored.minuteOfDay);
  return {
    enabled,
    installId: enabled ? (stored.installId as string) : null,
    minuteOfDay: enabled ? (stored.minuteOfDay as number) : null,
    answeredAt,
    answeredBy: stored.answeredBy === "environment" ? "environment" : "administrator",
  };
}

function readPendingErasures(value: unknown): PendingErasure[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (entry): entry is PendingErasure =>
        isRecord(entry) &&
        isUuidV4(entry.installId) &&
        typeof entry.attempts === "number" &&
        Number.isInteger(entry.attempts) &&
        entry.attempts >= 0 &&
        isoOrNull(entry.nextAttemptAt) !== null
    )
    .slice(0, MAX_PENDING_ERASURES);
}

export async function readUsagePingState(): Promise<UsagePingState> {
  const stored = await getSetting<unknown>(USAGE_PING_STATE_KEY);
  if (!isRecord(stored)) return { ...EMPTY_STATE, pendingErasures: [] };
  return {
    nextAttemptAt: isoOrNull(stored.nextAttemptAt),
    lastAttemptAt: isoOrNull(stored.lastAttemptAt),
    lastSuccessAt: isoOrNull(stored.lastSuccessAt),
    lastResult: stored.lastResult === "sent" || stored.lastResult === "failed" ? stored.lastResult : null,
    lastError: typeof stored.lastError === "string" ? stored.lastError.slice(0, 200) : null,
    lastFailureLoggedAt: isoOrNull(stored.lastFailureLoggedAt),
    pendingErasures: readPendingErasures(stored.pendingErasures),
  };
}

export async function writeUsagePingState(state: UsagePingState): Promise<void> {
  await setSetting(USAGE_PING_STATE_KEY, state);
}

/**
 * The payload for `installId`, as the scheduler sends it and the preview
 * shows it. Never built on a replica.
 */
export async function buildUsagePingPayloadFor(installId: string, role: "standalone" | "master"): Promise<UsagePingPayload> {
  return buildUsagePingPayload(installId, await collectUsagePingFacts(role));
}

function statusOf(settings: UsagePingSettings | null, role: InstanceMode, endpointError: string | null): UsagePingStatus {
  if (isUsagePingDisabledByEnv()) return "disabled_by_env";
  if (role === "slave") return "replica";
  if (settings === null) return "unanswered";
  if (!settings.enabled) return "off";
  if (endpointError) return "invalid_endpoint";
  return "on";
}

export async function getUsagePingView(): Promise<UsagePingView> {
  const [settings, state, role] = await Promise.all([readUsagePingSettings(), readUsagePingState(), getInstanceMode()]);
  const endpoint = resolveUsagePingEndpoint();
  const status = statusOf(settings, role, endpoint.error);
  const payload =
    role === "slave" ? null : await buildUsagePingPayloadFor(settings?.installId ?? PREVIEW_INSTALL_ID, role);
  return {
    enabled: settings?.enabled ?? false,
    answered: settings !== null,
    answeredAt: settings?.answeredAt ?? null,
    answeredBy: settings?.answeredBy ?? null,
    disabledByEnv: isUsagePingDisabledByEnv(),
    role,
    status,
    endpoint: endpoint.url,
    endpointError: endpoint.error,
    installId: settings?.installId ?? null,
    nextAttemptAt: status === "on" ? state.nextAttemptAt : null,
    lastAttemptAt: state.lastAttemptAt,
    lastSuccessAt: state.lastSuccessAt,
    lastResult: state.lastResult,
    lastError: state.lastError,
    pendingErasures: state.pendingErasures.length,
    payload,
  };
}

/** The overview question: shown to administrators until it is answered. */
export async function shouldAskUsagePingQuestion(): Promise<boolean> {
  if (isUsagePingDisabledByEnv()) return false;
  if ((await readUsagePingSettings()) !== null) return false;
  return (await getInstanceMode()) !== "slave";
}

/** The body of PUT /api/v1/usage-ping: exactly `{ "enabled": true | false }`. */
export function parseUsagePingInput(body: unknown): { enabled: boolean } {
  if (!isRecord(body)) throw new ApiValidationError("Request body must be a JSON object");
  const unknownKey = Object.keys(body).find((key) => key !== "enabled");
  if (unknownKey !== undefined) throw new ApiValidationError(`Unknown field: ${unknownKey.slice(0, 64)}`);
  if (typeof body.enabled !== "boolean") throw new ApiValidationError("enabled must be true or false");
  return { enabled: body.enabled };
}

/**
 * Asks the receiving service to delete what it stored for `installId`, now,
 * and keeps it for retries when that fails. Skipped while USAGE_PING_DISABLED
 * is set (it forbids every request to the endpoint): the receiving service
 * deletes installs it has not heard from for 90 days anyway.
 */
async function requestErasure(
  installId: string,
  now: Date,
  fetchImpl: typeof fetch
): Promise<UsagePingSendResult | null> {
  if (isUsagePingDisabledByEnv()) return null;
  const endpoint = resolveUsagePingEndpoint();
  const result: UsagePingSendResult = endpoint.url
    ? await sendUsagePingErasure(endpoint.url, installId, fetchImpl)
    : { ok: false, error: endpoint.error ?? "no endpoint" };
  if (!result.ok) {
    const state = await readUsagePingState();
    const pending = state.pendingErasures.filter((entry) => entry.installId !== installId);
    pending.push({ installId, attempts: 1, nextAttemptAt: new Date(now.getTime() + ERASURE_RETRY_INTERVAL_MS).toISOString() });
    await writeUsagePingState({ ...state, pendingErasures: pending.slice(-MAX_PENDING_ERASURES) });
  }
  return result;
}

function erasureSummary(result: UsagePingSendResult | null): string {
  if (result === null) return "";
  return result.ok
    ? "; asked the receiving service to delete its data"
    : `; asking the receiving service to delete its data failed (${result.error}) and is retried`;
}

/**
 * Answers the question, or changes the answer. Either answer hides the
 * overview question for good.
 *
 * On: a new random install id; the first ping goes out a few minutes later.
 * Off: deletes the install id and the send history, and, when a ping may
 * have reached the receiving service, asks it to delete its data.
 * `actorUserId` is null when USAGE_PING_ENABLED gives the answer.
 */
export async function setUsagePingEnabled(
  enabled: boolean,
  actorUserId: number | null,
  now: Date = new Date(),
  fetchImpl: typeof fetch = fetch
): Promise<UsagePingView> {
  const current = await readUsagePingSettings();
  const answeredBy: UsagePingAnsweredBy = actorUserId === null ? "environment" : "administrator";
  if (enabled) {
    if (isUsagePingDisabledByEnv()) {
      throw new ApiConflictError("The usage ping is turned off on this install by the USAGE_PING_DISABLED environment variable");
    }
    if ((await getInstanceMode()) === "slave") {
      throw new ApiConflictError("A replica never sends the usage ping; turn it on on the master instead");
    }
    if (current?.enabled) return getUsagePingView();
    const state = await readUsagePingState();
    await setSetting<UsagePingSettings>(USAGE_PING_SETTING_KEY, {
      enabled: true,
      installId: randomUUID(),
      minuteOfDay: randomMinuteOfDay(),
      answeredAt: now.toISOString(),
      answeredBy,
    });
    await writeUsagePingState({
      ...EMPTY_STATE,
      pendingErasures: state.pendingErasures,
      nextAttemptAt: firstAttemptAfterOptIn(now).toISOString(),
    });
    await logAuditEvent({
      userId: actorUserId,
      action: "usage_ping_enabled",
      entityType: "usage_ping",
      summary:
        answeredBy === "environment"
          ? "Turned on the anonymous usage ping (USAGE_PING_ENABLED)"
          : "Turned on the anonymous usage ping",
      data: { enabled: true, answeredBy },
    });
    return getUsagePingView();
  }

  if (current && !current.enabled) return getUsagePingView();
  const state = await readUsagePingState();
  const previousId = current?.installId ?? null;
  const mayHaveReachedService = previousId !== null && state.lastAttemptAt !== null;
  await setSetting<UsagePingSettings>(USAGE_PING_SETTING_KEY, {
    enabled: false,
    installId: null,
    minuteOfDay: null,
    answeredAt: now.toISOString(),
    answeredBy,
  });
  if (state.pendingErasures.length > 0) {
    await writeUsagePingState({ ...EMPTY_STATE, pendingErasures: state.pendingErasures });
  } else {
    await clearSetting(USAGE_PING_STATE_KEY);
  }
  const erasure = mayHaveReachedService ? await requestErasure(previousId, now, fetchImpl) : null;
  await logAuditEvent({
    userId: actorUserId,
    action: "usage_ping_disabled",
    entityType: "usage_ping",
    summary: current?.enabled
      ? `Turned off the anonymous usage ping and deleted its install id${erasureSummary(erasure)}`
      : "Declined the anonymous usage ping",
    data: { enabled: false, erasureRequested: erasure !== null, erasureDelivered: erasure?.ok ?? false },
  });
  return getUsagePingView();
}

/**
 * USAGE_PING_ENABLED answers yes for installs nobody signs in to. Called at
 * start-up; does nothing once the question is answered (an administrator's
 * later answer wins), on a replica or with USAGE_PING_DISABLED.
 */
export async function applyUsagePingEnvironmentAnswer(now: Date = new Date()): Promise<boolean> {
  if (!isUsagePingEnabledByEnv() || isUsagePingDisabledByEnv()) return false;
  if ((await getInstanceMode()) === "slave") return false;
  if ((await readUsagePingSettings()) !== null) return false;
  await setUsagePingEnabled(true, null, now);
  return true;
}

/**
 * A new random install id (and a new minute of the day), so later pings
 * cannot be linked to earlier ones by either; the receiving service is asked
 * to delete what it stored for the old id. The next ping goes out at the new
 * daily slot.
 */
export async function resetUsagePingInstallId(
  actorUserId: number,
  now: Date = new Date(),
  fetchImpl: typeof fetch = fetch
): Promise<UsagePingView> {
  const current = await readUsagePingSettings();
  if (!current?.enabled || !current.installId) {
    throw new ApiConflictError("The usage ping is off, so there is no install id to reset");
  }
  const state = await readUsagePingState();
  const minuteOfDay = randomMinuteOfDay();
  await setSetting<UsagePingSettings>(USAGE_PING_SETTING_KEY, { ...current, installId: randomUUID(), minuteOfDay });
  await writeUsagePingState({ ...state, nextAttemptAt: nextDailyAttempt(minuteOfDay, now).toISOString() });
  const erasure = state.lastAttemptAt !== null ? await requestErasure(current.installId, now, fetchImpl) : null;
  await logAuditEvent({
    userId: actorUserId,
    action: "usage_ping_install_id_reset",
    entityType: "usage_ping",
    summary: `Reset the usage ping install id${erasureSummary(erasure)}`,
  });
  return getUsagePingView();
}

/**
 * Delivers erasure requests that failed before, each at most every
 * ERASURE_RETRY_INTERVAL_MS and ERASURE_MAX_ATTEMPTS times. Called by the
 * scheduler.
 */
export async function retryPendingErasures(now: Date, fetchImpl: typeof fetch = fetch): Promise<number> {
  if (isUsagePingDisabledByEnv()) return 0;
  const state = await readUsagePingState();
  if (state.pendingErasures.length === 0) return 0;
  const endpoint = resolveUsagePingEndpoint();
  let delivered = 0;
  const remaining: PendingErasure[] = [];
  for (const entry of state.pendingErasures) {
    if (Date.parse(entry.nextAttemptAt) > now.getTime()) {
      remaining.push(entry);
      continue;
    }
    const result = endpoint.url ? await sendUsagePingErasure(endpoint.url, entry.installId, fetchImpl) : { ok: false };
    if (result.ok) {
      delivered++;
    } else if (entry.attempts + 1 < ERASURE_MAX_ATTEMPTS) {
      remaining.push({
        installId: entry.installId,
        attempts: entry.attempts + 1,
        nextAttemptAt: new Date(now.getTime() + ERASURE_RETRY_INTERVAL_MS).toISOString(),
      });
    }
  }
  // An erasure added while these requests were out stays queued.
  const latest = await readUsagePingState();
  const retried = new Set(state.pendingErasures.map((entry) => entry.installId));
  const added = latest.pendingErasures.filter((entry) => !retried.has(entry.installId));
  await writeUsagePingState({ ...latest, pendingErasures: [...remaining, ...added].slice(-MAX_PENDING_ERASURES) });
  return delivered;
}
