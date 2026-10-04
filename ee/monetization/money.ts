// SPDX-License-Identifier: Elastic-2.0
/**
 * Money helpers (client-safe). Amounts are integer micro-units of the
 * currency's major unit: 1 USD = 1,000,000 micro-units. Stripe amounts are in
 * the currency's smallest unit (cents for USD, yen for JPY), so converting
 * between the two multiplies by 10^(6 - decimals).
 */

export const MICROS_PER_UNIT = 1_000_000;

/** Stripe's zero-decimal currencies (amounts are whole units). */
const ZERO_DECIMAL = new Set([
  "bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga", "pyg", "rwf", "ugx", "vnd", "vuv", "xaf", "xof", "xpf",
]);
/** Stripe's three-decimal currencies. */
const THREE_DECIMAL = new Set(["bhd", "jod", "kwd", "omr", "tnd"]);

export const DEFAULT_CURRENCY = "usd";

/** Upper bound of any single amount (a price, a balance change, an allowance): 10^13 micro-units. */
export const MAX_AMOUNT_MICROS = 10_000_000_000_000;

export function isCurrencyCode(value: unknown): value is string {
  return typeof value === "string" && /^[a-z]{3}$/.test(value);
}

/** Decimal places of the currency's smallest unit, as Stripe counts them. */
export function currencyDecimals(currency: string): number {
  const code = currency.toLowerCase();
  if (ZERO_DECIMAL.has(code)) return 0;
  if (THREE_DECIMAL.has(code)) return 3;
  return 2;
}

/** Micro-units in one smallest unit of the currency (10,000 for USD cents). */
export function microsPerMinorUnit(currency: string): number {
  return 10 ** (6 - currencyDecimals(currency));
}

export function minorToMicros(minor: number, currency: string): number {
  return minor * microsPerMinorUnit(currency);
}

/** Null when the amount is not a whole number of smallest units (Stripe cannot charge it). */
export function microsToMinor(micros: number, currency: string): number | null {
  const per = microsPerMinorUnit(currency);
  return micros % per === 0 ? micros / per : null;
}

/** "12.345678" style decimal string of a micro-unit amount, trailing zeros trimmed to the currency's decimals. */
export function microsToDecimal(micros: number, currency: string): string {
  const negative = micros < 0;
  const abs = Math.abs(micros);
  const whole = Math.floor(abs / MICROS_PER_UNIT);
  let fraction = String(abs % MICROS_PER_UNIT).padStart(6, "0");
  const keep = currencyDecimals(currency);
  fraction = fraction.replace(/0+$/, "");
  if (fraction.length < keep) fraction = fraction.padEnd(keep, "0");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

/** "12.50 USD", "0.0005 USD". */
export function formatMicros(micros: number, currency: string): string {
  return `${microsToDecimal(micros, currency)} ${currency.toUpperCase()}`;
}

/**
 * Parses a decimal amount in major units ("12.5", "0.0005") into micro-units.
 * Null for anything that is not a plain decimal with at most six decimals.
 */
export function decimalToMicros(text: string): number | null {
  const match = /^(-)?(\d{1,13})(?:\.(\d{1,6}))?$/.exec(text.trim());
  if (!match) return null;
  const value = Number(match[2]) * MICROS_PER_UNIT + Number((match[3] ?? "").padEnd(6, "0"));
  if (!Number.isSafeInteger(value)) return null;
  return match[1] && value !== 0 ? -value : value;
}

const symbolCache = new Map<string, string | null>();

/** The currency's narrow symbol ("€", "$", "¥"), or null where there is none but the code itself (CHF). */
export function currencySymbol(currency: string): string | null {
  const code = currency.toUpperCase();
  if (symbolCache.has(code)) return symbolCache.get(code)!;
  let symbol: string | null;
  try {
    const part = new Intl.NumberFormat("en-US", { style: "currency", currency: code, currencyDisplay: "narrowSymbol" })
      .formatToParts(0)
      .find((item) => item.type === "currency")?.value;
    symbol = part && !/^[A-Z]{3}$/.test(part.trim()) ? part.trim() : null;
  } catch {
    // Not a currency Intl knows: show the code.
    symbol = null;
  }
  symbolCache.set(code, symbol);
  return symbol;
}

/**
 * A micro-unit amount for display, exact (no floating point): "€1,234.50",
 * "€0.0005", "-$2.00", or "12.50 CHF" for a currency without a symbol.
 * At least the currency's decimals, or `decimals` when more are asked for
 * (to line up prices in a column); more where the amount needs them.
 */
export function formatMoney(micros: number, currency: string, options: { decimals?: number } = {}): string {
  const negative = micros < 0;
  const abs = Math.abs(micros);
  const whole = Math.floor(abs / MICROS_PER_UNIT);
  const keep = Math.min(6, Math.max(currencyDecimals(currency), options.decimals ?? 0));
  let fraction = String(abs % MICROS_PER_UNIT).padStart(6, "0").replace(/0+$/, "");
  if (fraction.length < keep) fraction = fraction.padEnd(keep, "0");
  const number = `${whole.toLocaleString("en-US")}${fraction ? `.${fraction}` : ""}`;
  const sign = negative ? "-" : "";
  const symbol = currencySymbol(currency);
  return symbol ? `${sign}${symbol}${number}` : `${sign}${number} ${currency.toUpperCase()}`;
}

/** Decimals `formatMoney` needs to show every amount exactly, at least the currency's (for a column of prices). */
export function decimalsFor(amounts: readonly number[], currency: string): number {
  let decimals = currencyDecimals(currency);
  for (const micros of amounts) {
    const fraction = String(Math.abs(micros) % MICROS_PER_UNIT).padStart(6, "0").replace(/0+$/, "");
    decimals = Math.max(decimals, fraction.length);
  }
  return decimals;
}
