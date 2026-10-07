// SPDX-License-Identifier: Elastic-2.0
/**
 * Retention of API monetization history: hourly usage rows and failed-answer
 * credit rows of the ledger older than the configured number of months
 * (options.ts, default 13) are deleted, in batches, by the leader once a
 * day. Top-ups, payments, refunds, disputes and adjustments are kept: they
 * are the record of money moved. Credited charge ids are pruned once they can
 * no longer be credited (answer-credits.ts). Balances never change: they are
 * kept on the consumers, not summed from the ledger.
 */
import { and, inArray, lt } from "drizzle-orm";
import { appDb } from "@/src/lib/db";
import { monetizationLedger } from "@/src/lib/db/schema";
import { tryWithClusterLock } from "@/src/lib/db/locks";
import { pruneAnswerCredits } from "./answer-credits";
import { getMonetizationOptions } from "./options";

const BATCH = 2_000;
/** The ledger types that are hourly history rather than money moved. */
export const PRUNABLE_LEDGER_TYPES = ["usage", "credit"] as const;

/** The first moment kept: `months` calendar months before `now` (UTC). */
export function retentionCutoff(now: number, months: number): string {
  const date = new Date(now);
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - months, date.getUTCDate(), date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds())
  ).toISOString();
}

export type RetentionResult = { ledgerRows: number; answerCredits: number; cutoff: string };

/** Deletes history older than the retention. One run at a time across nodes; skipped (null) while another runs. */
export async function pruneMonetizationHistory(now: number = Date.now()): Promise<RetentionResult | null> {
  const outcome = await tryWithClusterLock("monetization-retention", async () => {
    const { usageRetentionMonths } = await getMonetizationOptions();
    const cutoff = retentionCutoff(now, usageRetentionMonths);
    let ledgerRows = 0;
    for (;;) {
      const ids = (await appDb
        .select({ id: monetizationLedger.id })
        .from(monetizationLedger)
        .where(and(inArray(monetizationLedger.type, [...PRUNABLE_LEDGER_TYPES]), lt(monetizationLedger.createdAt, cutoff)))
        .limit(BATCH)).map((row) => row.id);
      if (ids.length === 0) break;
      await appDb.delete(monetizationLedger).where(inArray(monetizationLedger.id, ids));
      ledgerRows += ids.length;
      if (ids.length < BATCH) break;
    }
    const answerCredits = await pruneAnswerCredits(now);
    if (ledgerRows > 0) console.log(`[monetization] Deleted ${ledgerRows} usage history row(s) older than ${usageRetentionMonths} month(s)`);
    return { ledgerRows, answerCredits, cutoff };
  });
  return outcome.acquired ? outcome.value : null;
}
