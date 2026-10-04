// SPDX-License-Identifier: Elastic-2.0
/**
 * Background jobs of audit streaming: delivery to sinks every few seconds and
 * the daily retention run. Both keep running whatever the license state: the
 * license only gates changing the configuration.
 *
 * Delivery is at-least-once: a sink's cursor advances only after the receiver
 * accepted a batch, and a failed batch is retried, with exponential backoff
 * per sink, until it is accepted.
 */
import { and, eq } from "drizzle-orm";
import { appDb } from "@/src/lib/db";
import { auditSinks } from "@/src/lib/db/schema";
import { readAuditRecords } from "./records";
import { deliverEvents, describeDeliveryError, localHostname, toStreamEvent } from "./delivery";
import { toDeliverableSink, type AuditSinkRow } from "./sinks";
import { pruneAuditEvents } from "./retention";

export const STREAM_INTERVAL_MS = 10_000;
export const STREAM_BATCH_SIZE = 100;
/** Batches per sink and tick, so one busy sink cannot hold up the others for long. */
const MAX_BATCHES_PER_TICK = 20;
const BACKOFF_BASE_MS = 10_000;
const BACKOFF_MAX_MS = 30 * 60_000;
const RETENTION_INTERVAL_MS = 24 * 60 * 60_000;
const RETENTION_FIRST_RUN_MS = 60_000;
const MAX_ERROR_LENGTH = 300;

/** Delay before retrying a sink that failed `failures` times in a row. */
export function backoffDelayMs(failures: number): number {
  if (failures <= 0) return 0;
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.min(failures - 1, 20), BACKOFF_MAX_MS);
}

export type StreamTickResult = { sinks: number; delivered: number; failed: number };

async function recordFailure(sink: AuditSinkRow, error: unknown, now: Date): Promise<void> {
  const failures = sink.consecutiveFailures + 1;
  await appDb
    .update(auditSinks)
    .set({
      lastError: describeDeliveryError(error).slice(0, MAX_ERROR_LENGTH),
      lastErrorAt: now.toISOString(),
      consecutiveFailures: failures,
      nextAttemptAt: new Date(now.getTime() + backoffDelayMs(failures)).toISOString(),
    })
    .where(eq(auditSinks.id, sink.id));
}

/** Delivers pending events to one sink; returns how many it delivered. */
async function streamSink(sink: AuditSinkRow, now: () => Date, host: string): Promise<{ delivered: number; failed: boolean }> {
  let cursor = sink.lastDeliveredId;
  let delivered = 0;
  for (let batch = 0; batch < MAX_BATCHES_PER_TICK; batch++) {
    const records = await readAuditRecords(cursor, STREAM_BATCH_SIZE);
    if (records.length === 0) break;
    try {
      await deliverEvents(toDeliverableSink(sink), records.map((record) => toStreamEvent(record, host)));
    } catch (error) {
      await recordFailure(sink, error, now());
      return { delivered, failed: true };
    }
    const next = records[records.length - 1].id;
    // Conditional on the cursor this run started from: if the sink was
    // edited or deleted meanwhile, its new state wins.
    const updated = await appDb
      .update(auditSinks)
      .set({ lastDeliveredId: next, lastDeliveryAt: now().toISOString(), consecutiveFailures: 0, nextAttemptAt: null })
      .where(and(eq(auditSinks.id, sink.id), eq(auditSinks.lastDeliveredId, cursor)))
      .returning({ id: auditSinks.id });
    if (updated.length === 0) break;
    delivered += records.length;
    cursor = next;
    sink = { ...sink, lastDeliveredId: next, consecutiveFailures: 0, nextAttemptAt: null };
    if (records.length < STREAM_BATCH_SIZE) break;
  }
  return { delivered, failed: false };
}

let tickRunning = false;

/** One pass over the enabled sinks. Returns null when the previous pass is still running. */
export async function runAuditStreamingTick(now: () => Date = () => new Date()): Promise<StreamTickResult | null> {
  if (tickRunning) return null;
  tickRunning = true;
  try {
    const sinks = await appDb.select().from(auditSinks).where(eq(auditSinks.enabled, true));
    const host = localHostname();
    const result: StreamTickResult = { sinks: 0, delivered: 0, failed: 0 };
    const current = now().toISOString();
    for (const sink of sinks) {
      if (sink.nextAttemptAt && sink.nextAttemptAt > current) continue;
      result.sinks += 1;
      try {
        const outcome = await streamSink(sink, now, host);
        result.delivered += outcome.delivered;
        if (outcome.failed) result.failed += 1;
      } catch (error) {
        // A database error for one sink must not stop the others.
        result.failed += 1;
        console.error(`Audit streaming to sink ${sink.id} failed:`, error);
      }
    }
    return result;
  } finally {
    tickRunning = false;
  }
}

/**
 * Starts delivery and retention timers; returns a function that stops them.
 * Callers must not start it in tests.
 */
export function startAuditBackgroundJobs(): () => void {
  const streamTimer = setInterval(() => {
    runAuditStreamingTick().catch((error) => console.error("Audit streaming tick failed:", error));
  }, STREAM_INTERVAL_MS);
  const runRetention = () => {
    pruneAuditEvents().catch((error) => console.error("Audit log retention failed:", error));
  };
  const firstRetention = setTimeout(runRetention, RETENTION_FIRST_RUN_MS);
  const retentionTimer = setInterval(runRetention, RETENTION_INTERVAL_MS);
  for (const timer of [streamTimer, firstRetention, retentionTimer]) timer.unref?.();
  return () => {
    clearInterval(streamTimer);
    clearTimeout(firstRetention);
    clearInterval(retentionTimer);
  };
}
