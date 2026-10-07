// SPDX-License-Identifier: Elastic-2.0
"use client";

import type { ReactNode } from "react";
import { Label } from "@/components/ui/label";
import { decimalToMicros, formatMoney, microsToDecimal } from "../money";

export const API_BASE = "/api/v1/monetization";

async function readError(response: Response): Promise<string> {
  try {
    const data = await response.json();
    if (data && typeof data.error === "string") return data.error;
  } catch {
    // fall through
  }
  return `Request failed (HTTP ${response.status})`;
}

/** Calls the monetization REST API with the dashboard session; throws with the API's message. */
export async function callApi<T = unknown>(path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(await readError(response));
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export function Field({ label, htmlFor, children, hint }: { label: string; htmlFor?: string; children: ReactNode; hint?: string }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** "€12.50", "€0.0005": exact, in the install's currency. `decimals` lines up a column of prices. */
export function money(micros: number, currency: string, decimals?: number): string {
  return formatMoney(micros, currency, { decimals });
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "October" for "2026-10-01" (UTC). */
export function monthName(day: string): string {
  return MONTHS[Number(day.slice(5, 7)) - 1] ?? day;
}

const pad = (value: number) => String(value).padStart(2, "0");

/**
 * A timestamp in UTC, short: "11:35" today, "2 Oct 17:40" this year,
 * "2 Oct 2025" before. `now` is the page's reference time (server-rendered,
 * so the text does not change on hydration).
 */
export function shortTime(iso: string, now: string): string {
  const at = new Date(iso);
  const ref = new Date(now);
  if (Number.isNaN(at.getTime())) return iso;
  const time = `${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}`;
  const day = `${at.getUTCDate()} ${SHORT_MONTHS[at.getUTCMonth()]}`;
  if (iso.slice(0, 10) === now.slice(0, 10)) return time;
  if (at.getUTCFullYear() === ref.getUTCFullYear()) return `${day} ${time}`;
  return `${day} ${at.getUTCFullYear()}`;
}

/** Major-unit text for an input ("0.0005"). */
export function toInput(micros: number, currency: string): string {
  return microsToDecimal(micros, currency);
}

/** Micro-units of a major-unit input, or an error message. */
export function fromInput(text: string, field: string, options: { allowNegative?: boolean } = {}): number | string {
  const value = decimalToMicros(text);
  if (value === null) return `${field} must be a number with at most six decimals`;
  if (value < 0 && !options.allowNegative) return `${field} must not be negative`;
  return value;
}
