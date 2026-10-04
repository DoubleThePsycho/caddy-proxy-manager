// SPDX-License-Identifier: Elastic-2.0
/**
 * The arithmetic of the API monetization overview (overview.ts): month
 * totals, days and top consumers from ledger aggregates. Pure and
 * client-safe, so it is tested without a database. Months and days are UTC;
 * amounts stay integer micro-units (sums only, nothing divides money).
 */
import type {
  ConsumerView,
  MonetizationConsumerUsage,
  MonetizationDay,
  MonetizationMonthTotals,
  MonetizationOverview,
  MonetizationTopConsumer,
} from "./types";

export const OVERVIEW_DAYS = 30;
export const OVERVIEW_TOP_CONSUMERS = 5;

const DAY_MS = 86_400_000;

/** Ledger rows of one UTC day and type, summed. */
export type DailyAggregate = { day: string; type: string; amountMicros: number; requests: number; freeRequests: number; entries: number };

/** This month's ledger rows of one consumer and type, summed. */
export type ConsumerAggregate = { consumerId: number; type: string; amountMicros: number; requests: number; freeRequests: number };

export type KeyAggregate = { consumerId: number; lastUsedAt: string | null; revoked: number; lastRevokedAt: string | null };

export type OverviewInputs = {
  now: Date;
  currency: string;
  daily: readonly DailyAggregate[];
  consumerUsage: readonly ConsumerAggregate[];
  keys: readonly KeyAggregate[];
  /** Consumers whose balance was ever topped up or raised by an adjustment. */
  funded: ReadonlySet<number>;
  consumers: readonly ConsumerView[];
  lastTopUp: MonetizationOverview["lastTopUp"];
  /** This month's x402 payments; none when left out. */
  x402?: MonetizationOverview["x402"];
};

/** The periods the overview covers, as ISO strings and "YYYY-MM-DD" days. */
export function overviewPeriods(now: Date): {
  monthStart: string;
  previousMonthStart: string;
  windowStart: string;
  /** Start of tomorrow (UTC): the exclusive end of every period. */
  end: string;
  days: string[];
} {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const today = Date.UTC(year, month, now.getUTCDate());
  const windowStart = today - (OVERVIEW_DAYS - 1) * DAY_MS;
  return {
    monthStart: new Date(Date.UTC(year, month, 1)).toISOString(),
    previousMonthStart: new Date(Date.UTC(year, month - 1, 1)).toISOString(),
    windowStart: new Date(windowStart).toISOString(),
    end: new Date(today + DAY_MS).toISOString(),
    days: Array.from({ length: OVERVIEW_DAYS }, (_, i) => new Date(windowStart + i * DAY_MS).toISOString().slice(0, 10)),
  };
}

function emptyMonth(month: string): MonetizationMonthTotals {
  return {
    month,
    paidInMicros: 0,
    topUps: 0,
    payments: 0,
    refundedMicros: 0,
    chargedMicros: 0,
    creditedMicros: 0,
    creditedRequests: 0,
    requests: 0,
    chargedRequests: 0,
    freeRequests: 0,
    adjustmentsMicros: 0,
    adjustments: 0,
  };
}

function addToMonth(totals: MonetizationMonthTotals, row: DailyAggregate): void {
  if (row.type === "topup") {
    totals.paidInMicros += row.amountMicros;
    totals.topUps += row.entries;
  } else if (row.type === "usage") {
    // Usage rows store what was charged as a negative amount.
    totals.chargedMicros -= row.amountMicros;
    totals.requests += row.requests;
    totals.freeRequests += row.freeRequests;
    totals.chargedRequests += row.requests - row.freeRequests;
  } else if (row.type === "adjustment") {
    totals.adjustmentsMicros += row.amountMicros;
    totals.adjustments += row.entries;
  } else if (row.type === "payment") {
    totals.paidInMicros += row.amountMicros;
    totals.payments += row.entries;
  } else if (row.type === "credit") {
    // Failed answers credited back: what requests cost is net of them.
    totals.chargedMicros -= row.amountMicros;
    totals.creditedMicros += row.amountMicros;
    totals.creditedRequests += row.requests;
  } else if (row.type === "refund" || row.type === "dispute") {
    totals.refundedMicros -= row.amountMicros;
  }
}

/** The overview from ledger aggregates; pure, so the arithmetic is tested without a database. */
export function summarizeOverview(inputs: OverviewInputs): MonetizationOverview {
  const periods = overviewPeriods(inputs.now);
  const thisMonthKey = periods.monthStart.slice(0, 10);
  const previousMonthKey = periods.previousMonthStart.slice(0, 10);
  const thisMonth = emptyMonth(thisMonthKey);
  const previousMonth = emptyMonth(previousMonthKey);
  const byDay = new Map<string, MonetizationDay>(
    periods.days.map((day) => [day, { day, requests: 0, chargedRequests: 0, freeRequests: 0, chargedMicros: 0, paidInMicros: 0 }])
  );

  for (const row of inputs.daily) {
    if (row.day >= thisMonthKey) addToMonth(thisMonth, row);
    else if (row.day >= previousMonthKey) addToMonth(previousMonth, row);
    const day = byDay.get(row.day);
    if (!day) continue;
    if (row.type === "usage") {
      day.requests += row.requests;
      day.freeRequests += row.freeRequests;
      day.chargedRequests += row.requests - row.freeRequests;
      day.chargedMicros -= row.amountMicros;
    } else if (row.type === "topup" || row.type === "payment") {
      day.paidInMicros += row.amountMicros;
    } else if (row.type === "credit") {
      day.chargedMicros -= row.amountMicros;
    }
  }

  const usage = new Map<number, MonetizationConsumerUsage>();
  const entry = (consumerId: number): MonetizationConsumerUsage => {
    let found = usage.get(consumerId);
    if (!found) {
      found = {
        consumerId,
        requests: 0,
        chargedRequests: 0,
        freeRequests: 0,
        chargedMicros: 0,
        keysLastUsedAt: null,
        revokedKeys: 0,
        lastRevokedAt: null,
        funded: inputs.funded.has(consumerId),
      };
      usage.set(consumerId, found);
    }
    return found;
  };
  for (const row of inputs.consumerUsage) {
    if (row.type === "credit") {
      entry(row.consumerId).chargedMicros -= row.amountMicros;
      continue;
    }
    if (row.type !== "usage") continue;
    const item = entry(row.consumerId);
    item.requests += row.requests;
    item.freeRequests += row.freeRequests;
    item.chargedRequests += row.requests - row.freeRequests;
    item.chargedMicros -= row.amountMicros;
  }
  for (const key of inputs.keys) {
    const item = entry(key.consumerId);
    item.keysLastUsedAt = key.lastUsedAt;
    item.revokedKeys = key.revoked;
    item.lastRevokedAt = key.lastRevokedAt;
  }
  for (const consumerId of inputs.funded) entry(consumerId);

  const consumersById = new Map(inputs.consumers.map((consumer) => [consumer.id, consumer]));
  const monthRequests = thisMonth.requests;
  const topConsumers: MonetizationTopConsumer[] = [...usage.values()]
    .filter((item) => item.requests > 0 || item.chargedMicros > 0)
    .sort((a, b) => b.requests - a.requests || b.chargedMicros - a.chargedMicros || a.consumerId - b.consumerId)
    .slice(0, OVERVIEW_TOP_CONSUMERS)
    .map((item) => {
      const consumer = consumersById.get(item.consumerId);
      return {
        consumerId: item.consumerId,
        name: consumer?.name ?? null,
        planName: consumer?.planName ?? null,
        requests: item.requests,
        chargedMicros: item.chargedMicros,
        share: monthRequests > 0 ? item.requests / monthRequests : 0,
      };
    });

  const balances = {
    consumers: inputs.consumers.length,
    heldMicros: 0,
    heldFor: 0,
    heldForDisabled: 0,
    overdrawnMicros: 0,
    overdrawn: 0,
    postpaidOpenMicros: 0,
    postpaidOpen: 0,
  };
  for (const consumer of inputs.consumers) {
    if (consumer.balanceMicros > 0) {
      balances.heldMicros += consumer.balanceMicros;
      balances.heldFor += 1;
      if (consumer.status === "disabled") balances.heldForDisabled += 1;
    } else if (consumer.balanceMicros < 0 && consumer.billing === "postpaid") {
      balances.postpaidOpenMicros -= consumer.balanceMicros;
      balances.postpaidOpen += 1;
    } else if (consumer.balanceMicros < 0) {
      balances.overdrawnMicros -= consumer.balanceMicros;
      balances.overdrawn += 1;
    }
  }

  return {
    currency: inputs.currency,
    generatedAt: inputs.now.toISOString(),
    thisMonth,
    previousMonth,
    days: periods.days.map((day) => byDay.get(day)!),
    topConsumers,
    consumers: [...usage.values()].sort((a, b) => a.consumerId - b.consumerId),
    balances,
    lastTopUp: inputs.lastTopUp,
    x402: inputs.x402 ?? { settled: 0, failed: 0, pending: 0, amountCents: 0 },
  };
}
