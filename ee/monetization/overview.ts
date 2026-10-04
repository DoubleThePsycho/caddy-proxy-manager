// SPDX-License-Identifier: Elastic-2.0
/**
 * The API monetization overview: this month's and last month's totals, the
 * last 30 days per UTC day and the month's top consumers, all read from the
 * ledger, and the prepaid balances held. Months and days are UTC, as the
 * plans' free requests are. Every amount stays an integer number of
 * micro-units: SQLite sums integers exactly, and nothing here divides money.
 *
 * Reading only; no license check (reads never need one).
 */
import { and, eq, gte, inArray, lt, or, sql } from "drizzle-orm";
import { appDb } from "@/src/lib/db";
import { monetizationConsumers, monetizationKeys, monetizationLedger } from "@/src/lib/db/schema";
import { listConsumers } from "./consumers";
import { readCurrency } from "./settings";
import { overviewPeriods, summarizeOverview } from "./overview-summary";
import { summarizeX402 } from "./x402/payments";
import type { ConsumerView, MonetizationOverview } from "./types";
import { desc, first } from "@/src/lib/db/ops";

export { OVERVIEW_DAYS, OVERVIEW_TOP_CONSUMERS, overviewPeriods, summarizeOverview } from "./overview-summary";

const sumInt = (column: typeof monetizationLedger.amountMicros | typeof monetizationLedger.requests | typeof monetizationLedger.freeRequests) =>
  sql<number>`coalesce(sum(${column}), 0)`.mapWith(Number);

/**
 * The overview as of `now`. `consumers` (the effective balances) can be
 * passed when the caller has already listed them.
 */
export async function getMonetizationOverview(options: { now?: Date; consumers?: ConsumerView[] } = {}): Promise<MonetizationOverview> {
  const now = options.now ?? new Date();
  const periods = overviewPeriods(now);
  const consumers = options.consumers ?? (await listConsumers());
  const from = periods.previousMonthStart < periods.windowStart ? periods.previousMonthStart : periods.windowStart;

  const dayExpr = sql<string>`substr(${monetizationLedger.createdAt}, 1, 10)`;
  const daily = await appDb
    .select({
      day: dayExpr,
      type: monetizationLedger.type,
      amountMicros: sumInt(monetizationLedger.amountMicros),
      requests: sumInt(monetizationLedger.requests),
      freeRequests: sumInt(monetizationLedger.freeRequests),
      entries: sql<number>`count(*)`.mapWith(Number),
    })
    .from(monetizationLedger)
    .where(and(gte(monetizationLedger.createdAt, from), lt(monetizationLedger.createdAt, periods.end)))
    .groupBy(dayExpr, monetizationLedger.type);

  const consumerUsage = await appDb
    .select({
      consumerId: monetizationLedger.consumerId,
      type: monetizationLedger.type,
      amountMicros: sumInt(monetizationLedger.amountMicros),
      requests: sumInt(monetizationLedger.requests),
      freeRequests: sumInt(monetizationLedger.freeRequests),
    })
    .from(monetizationLedger)
    .where(
      and(
        inArray(monetizationLedger.type, ["usage", "credit"]),
        gte(monetizationLedger.createdAt, periods.monthStart),
        lt(monetizationLedger.createdAt, periods.end)
      )
    )
    .groupBy(monetizationLedger.consumerId, monetizationLedger.type);

  const keys = await appDb
    .select({
      consumerId: monetizationKeys.consumerId,
      lastUsedAt: sql<string | null>`max(${monetizationKeys.lastUsedAt})`,
      revoked: sql<number>`sum(case when ${monetizationKeys.revokedAt} is null then 0 else 1 end)`.mapWith(Number),
      lastRevokedAt: sql<string | null>`max(${monetizationKeys.revokedAt})`,
    })
    .from(monetizationKeys)
    .groupBy(monetizationKeys.consumerId);

  const funded = new Set(
    (await appDb
      .selectDistinct({ consumerId: monetizationLedger.consumerId })
      .from(monetizationLedger)
      .where(
        or(
          eq(monetizationLedger.type, "topup"),
          eq(monetizationLedger.type, "payment"),
          and(eq(monetizationLedger.type, "adjustment"), sql`${monetizationLedger.amountMicros} > 0`)
        )
      ))
      .map((row) => row.consumerId)
  );

  const last = await first(appDb
    .select({
      consumerId: monetizationLedger.consumerId,
      consumerName: monetizationConsumers.name,
      amountMicros: monetizationLedger.amountMicros,
      at: monetizationLedger.createdAt,
    })
    .from(monetizationLedger)
    .leftJoin(monetizationConsumers, eq(monetizationConsumers.id, monetizationLedger.consumerId))
    .where(eq(monetizationLedger.type, "topup"))
    .orderBy(desc(monetizationLedger.createdAt), desc(monetizationLedger.id))
    .limit(1));

  return summarizeOverview({
    now,
    currency: await readCurrency(),
    daily,
    consumerUsage,
    keys,
    funded,
    consumers,
    lastTopUp: last ? { consumerId: last.consumerId, consumerName: last.consumerName ?? null, amountMicros: last.amountMicros, at: last.at } : null,
    x402: await summarizeX402(periods.monthStart, periods.end),
  });
}
