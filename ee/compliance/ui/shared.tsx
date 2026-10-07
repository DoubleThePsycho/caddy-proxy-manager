// SPDX-License-Identifier: Elastic-2.0
"use client";

import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import type { DeadlineStatus, FindingCounts, FindingSeverity } from "../types";

export const API_BASE = "/api/v1/compliance";

async function readError(response: Response): Promise<string> {
  try {
    const data = await response.json();
    if (data && typeof data.error === "string") return data.error;
  } catch {
    // fall through
  }
  return `Request failed (HTTP ${response.status})`;
}

/** Calls the compliance REST API with the dashboard session; throws with the API's message. */
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

const SEVERITY_VARIANT: Record<FindingSeverity, "destructive" | "warning" | "info" | "muted"> = {
  high: "destructive",
  medium: "warning",
  low: "info",
  info: "muted",
};

export function SeverityBadge({ severity }: { severity: FindingSeverity }) {
  return <Badge variant={SEVERITY_VARIANT[severity]}>{severity}</Badge>;
}

export function FindingCountBadges({ counts }: { counts: FindingCounts }) {
  const shown = (["high", "medium", "low"] as const).filter((severity) => counts[severity] > 0);
  if (shown.length === 0) return <span className="text-xs text-muted-foreground">No findings</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {shown.map((severity) => (
        <Badge key={severity} variant={SEVERITY_VARIANT[severity]}>
          {counts[severity]} {severity}
        </Badge>
      ))}
    </div>
  );
}

export function DeadlineBadge({ status }: { status: DeadlineStatus }) {
  if (status === "submitted") return <Badge variant="success">Submitted</Badge>;
  if (status === "overdue") return <Badge variant="destructive">Overdue</Badge>;
  return <Badge variant="warning">Open</Badge>;
}

/** "YYYY-MM-DDTHH:MM" in the browser's time zone, for datetime-local inputs. */
export function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** A datetime-local value (browser time zone) as ISO 8601 UTC, or null when empty or invalid. */
export function fromLocalInput(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Remaining or overdue time in words, e.g. "in 5 h" or "3 d ago". */
export function relativeDeadline(iso: string, now: number): string {
  const ms = Date.parse(iso) - now;
  const hours = Math.round(Math.abs(ms) / 3_600_000);
  const text = hours >= 48 ? `${Math.round(hours / 24)} d` : `${hours} h`;
  return ms >= 0 ? `in ${text}` : `${text} ago`;
}
