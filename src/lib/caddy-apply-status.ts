/**
 * The Caddy apply state of the instance: the outcome of the most recent
 * attempt to push the configuration to Caddy (what the overview, the
 * attention list, alerting and a replica's sync status report), and the
 * fingerprints of what Caddy took last (what the next apply and the Caddy
 * monitor compare against).
 *
 * Kept in the settings row `caddy_apply_state`, written by applyCaddyConfig
 * (src/lib/caddy.ts) while it holds the cluster lock "caddy-apply", so with
 * several replicas on one PostgreSQL every replica reports the same state,
 * whichever of them applied last. Not part of the configuration: never
 * exported, imported or synced to slaves (each instance has its own Caddy).
 */
import { eq } from "drizzle-orm";
import { appDb, nowIso } from "./db";
import { settings } from "./db/schema";
import { first } from "./db/ops";

export type CaddyApplyFailureCode =
  | "CADDY_REJECTED"
  | "CADDY_UNREACHABLE"
  | "CADDY_REQUEST_FAILED"
  | "CONFIG_BUILD_FAILED";

const FAILURE_CODES: readonly string[] = ["CADDY_REJECTED", "CADDY_UNREACHABLE", "CADDY_REQUEST_FAILED", "CONFIG_BUILD_FAILED"];

export type CaddyApplyStatus = {
  ok: boolean;
  /** When the attempt finished, ISO 8601. */
  at: string;
  /** Failure code; null after a successful apply. */
  code: CaddyApplyFailureCode | null;
  /** Application-authored, safe-to-show failure message; null after a success. */
  message: string | null;
  /** Failed attempts in a row (0 after a success). */
  consecutiveFailures: number;
};

/** The settings row the state is kept in. */
export const CADDY_APPLY_STATE_KEY = "caddy_apply_state";

export type CaddyApplyState = {
  /**
   * Increased by every recorded attempt. An apply records its outcome only
   * over the generation it read when it took the lock: a different one
   * means another apply ran meanwhile, so the lock was lost.
   */
  generation: number;
  /** sha256 of the last document Caddy accepted, as posted to /load. */
  documentHash: string | null;
  /** sha256 of Caddy's GET /config/ right after that apply: what Caddy serves until something changes it. */
  liveHash: string | null;
  /** The last attempt; null before the first. */
  status: CaddyApplyStatus | null;
};

export type CaddyApplyResult = { ok: true } | { ok: false; code: CaddyApplyFailureCode; message: string };

const EMPTY_STATE: CaddyApplyState = { generation: 0, documentHash: null, liveHash: null, status: null };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readHash(value: unknown): string | null {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value) ? value : null;
}

function readStatus(value: unknown): CaddyApplyStatus | null {
  if (!isRecord(value) || typeof value.ok !== "boolean" || typeof value.at !== "string") return null;
  const code = typeof value.code === "string" && FAILURE_CODES.includes(value.code) ? (value.code as CaddyApplyFailureCode) : null;
  const failures = typeof value.consecutiveFailures === "number" && Number.isSafeInteger(value.consecutiveFailures)
    ? Math.max(0, value.consecutiveFailures)
    : 0;
  return {
    ok: value.ok,
    at: value.at,
    code: value.ok ? null : code,
    message: !value.ok && typeof value.message === "string" ? value.message : null,
    consecutiveFailures: value.ok ? 0 : failures,
  };
}

function parseState(stored: string | null | undefined): CaddyApplyState {
  if (!stored) return EMPTY_STATE;
  let value: unknown;
  try {
    value = JSON.parse(stored);
  } catch {
    return EMPTY_STATE;
  }
  if (!isRecord(value)) return EMPTY_STATE;
  const generation = typeof value.generation === "number" && Number.isSafeInteger(value.generation) && value.generation >= 0
    ? value.generation
    : 0;
  return {
    generation,
    documentHash: readHash(value.documentHash),
    liveHash: readHash(value.liveHash),
    status: readStatus(value.status),
  };
}

/** The instance's apply state (on PostgreSQL, every replica's). */
export async function readCaddyApplyState(): Promise<CaddyApplyState> {
  const row = await first(
    appDb.select({ value: settings.value }).from(settings).where(eq(settings.key, CADDY_APPLY_STATE_KEY)).limit(1)
  );
  return parseState(row?.value);
}

/** The last recorded apply attempt, or null before the first one. */
export async function getCaddyApplyStatus(): Promise<CaddyApplyStatus | null> {
  return (await readCaddyApplyState()).status;
}

/**
 * Records an apply attempt: its outcome and, when Caddy took a document,
 * that document's fingerprints (a failed attempt keeps those of the last
 * document Caddy took, which it keeps serving). With `since`, records only
 * when no other attempt was recorded after generation `since`, and
 * otherwise writes nothing and returns false.
 */
export async function recordCaddyApplyResult(
  result: CaddyApplyResult,
  options: { since?: number; applied?: { documentHash: string; liveHash: string | null }; now?: Date } = {}
): Promise<boolean> {
  const at = (options.now ?? new Date()).toISOString();
  return await appDb.transaction(async (tx) => {
    const row = await first(
      tx.select({ value: settings.value }).from(settings).where(eq(settings.key, CADDY_APPLY_STATE_KEY)).limit(1)
    );
    const current = parseState(row?.value);
    if (options.since !== undefined && current.generation !== options.since) return false;
    const previousFailures = current.status && !current.status.ok ? current.status.consecutiveFailures : 0;
    const status: CaddyApplyStatus = result.ok
      ? { ok: true, at, code: null, message: null, consecutiveFailures: 0 }
      : { ok: false, at, code: result.code, message: result.message, consecutiveFailures: previousFailures + 1 };
    const next: CaddyApplyState = {
      generation: current.generation + 1,
      documentHash: options.applied ? options.applied.documentHash : current.documentHash,
      liveHash: options.applied ? options.applied.liveHash : current.liveHash,
      status,
    };
    const value = JSON.stringify(next);
    const updatedAt = nowIso();
    await tx
      .insert(settings)
      .values({ key: CADDY_APPLY_STATE_KEY, value, updatedAt })
      .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt } });
    return true;
  });
}

/** Test helper: forget the recorded state. */
export async function resetCaddyApplyStatusForTests(): Promise<void> {
  await appDb.delete(settings).where(eq(settings.key, CADDY_APPLY_STATE_KEY));
}
