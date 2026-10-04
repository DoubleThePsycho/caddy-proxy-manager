// SPDX-License-Identifier: Elastic-2.0
/**
 * Postpaid billing rules that need no database or network: card expiry,
 * Stripe's minimum charge, what a charge may take, billing periods.
 * Client-safe.
 *
 * Amounts are micro-units of the install's currency (money.ts). A charge is
 * always a whole number of the currency's smallest unit, rounded down, so a
 * card is never charged more than the usage it pays for; the remainder (less
 * than one cent, say) stays open for the next charge.
 */
import { MICROS_PER_UNIT, microsPerMinorUnit } from "./money";

/** The highest postpaid cap a plan may set: 10,000 units of the currency. */
export const MAX_POSTPAID_CAP_MICROS = 10_000 * MICROS_PER_UNIT;

/**
 * Stripe's minimum charge per currency, in the currency's smallest unit
 * (stripe.com/docs/currencies#minimum-and-maximum-charge-amounts). Other
 * currencies: one smallest unit; Stripe refuses a charge below its minimum
 * with amount_too_small, which leaves the amount open for the next period.
 */
const STRIPE_MINIMUM_MINOR: Record<string, number> = {
  usd: 50, aed: 200, aud: 50, bgn: 100, brl: 50, cad: 50, chf: 50, czk: 1500, dkk: 250, eur: 50, gbp: 30,
  hkd: 400, huf: 17500, inr: 50, jpy: 50, mxn: 1000, myr: 200, nok: 300, nzd: 50, pln: 200, ron: 200,
  sek: 300, sgd: 50, thb: 1000,
};

/** Stripe's smallest charge in the currency, in micro-units. */
export function minimumChargeMicros(currency: string): number {
  return (STRIPE_MINIMUM_MINOR[currency.toLowerCase()] ?? 1) * microsPerMinorUnit(currency);
}

/** The first moment a card valid through month/year (1-12, four digits) no longer works, in ms; null when unknown. */
export function cardExpiresAt(month: number | null | undefined, year: number | null | undefined): number | null {
  if (!Number.isInteger(month) || !Number.isInteger(year)) return null;
  if ((month as number) < 1 || (month as number) > 12 || (year as number) < 2000 || (year as number) > 2200) return null;
  return Date.UTC(year as number, month as number, 1);
}

/** Whether the card has expired at `now`. Unknown expiry: not expired (Stripe refuses the charge if it has). */
export function isCardExpired(month: number | null | undefined, year: number | null | undefined, now: number = Date.now()): boolean {
  const expiresAt = cardExpiresAt(month, year);
  return expiresAt !== null && now >= expiresAt;
}

/** A plan's threshold, or half its cap when it has none. */
export function effectiveThreshold(capMicros: number, thresholdMicros: number | null): number {
  if (thresholdMicros !== null && thresholdMicros > 0) return Math.min(thresholdMicros, capMicros);
  return Math.floor(capMicros / 2);
}

/**
 * What a charge may take now: the open amount less the charges still on
 * their way, rounded down to the currency's smallest unit. 0 when nothing is
 * chargeable.
 */
export function chargeableMicros(openMicros: number, pendingMicros: number, currency: string): number {
  const open = Math.max(0, openMicros - Math.max(0, pendingMicros));
  const per = microsPerMinorUnit(currency);
  return Math.floor(open / per) * per;
}

/** What paying the open amount in Checkout takes: rounded up, so the balance ends at zero or just above. */
export function openAmountToPay(openMicros: number, currency: string): number {
  const per = microsPerMinorUnit(currency);
  return Math.ceil(Math.max(0, openMicros) / per) * per;
}

/** "YYYY-MM" (UTC) of `now`. */
export function periodOf(now: number): string {
  return new Date(now).toISOString().slice(0, 7);
}

/** The billing period before `now`'s (UTC). */
export function previousPeriod(now: number): string {
  const date = new Date(now);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
}

/** The start of the next billing period (the 1st of next month, UTC), ISO 8601. */
export function nextPeriodStart(now: number): string {
  const date = new Date(now);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)).toISOString();
}
