// SPDX-License-Identifier: Elastic-2.0
"use client";

import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import type { CampaignStatus, CampaignSummary, ItemOutcome, ReviewScope } from "../types";

async function readError(response: Response): Promise<string> {
  try {
    const data = await response.json();
    if (data && typeof data.error === "string") return data.error;
  } catch {
    // fall through
  }
  return `Request failed (HTTP ${response.status})`;
}

/** Calls the REST API with the dashboard session; throws with the API's message. */
export async function callApi<T = unknown>(path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(await readError(response));
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export function Field({ label, htmlFor, children, hint }: { label: string; htmlFor?: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function formatDay(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString(undefined, { dateStyle: "medium" });
}

export function formatDateTime(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function StatusBadge({ status, overdue }: { status: CampaignStatus; overdue: boolean }) {
  if (status === "open") return overdue ? <Badge variant="warning">Overdue</Badge> : <Badge variant="info">Open</Badge>;
  return status === "completed" ? <Badge variant="success">Completed</Badge> : <Badge variant="muted">Cancelled</Badge>;
}

const OUTCOME_LABELS: Record<ItemOutcome, string> = {
  kept: "Kept",
  revoked: "Revoked",
  unchanged: "Unchanged",
  failed: "Failed",
  not_reviewed: "Not reviewed",
};

export function OutcomeBadge({ outcome, overdue }: { outcome: ItemOutcome | null; overdue: boolean }) {
  if (!outcome) return overdue ? <Badge variant="warning">Overdue</Badge> : <Badge variant="outline">Pending</Badge>;
  const variant = outcome === "revoked" ? "destructive" : outcome === "kept" ? "success" : outcome === "failed" ? "warning" : "muted";
  return <Badge variant={variant}>{OUTCOME_LABELS[outcome]}</Badge>;
}

export function describeScope(scope: ReviewScope, names: { customRoles: Map<number, string>; groups: Map<number, string> }): string {
  if (scope.type === "all") return "All active users";
  const parts = [
    ...scope.roles.map((role) => `role ${role}`),
    ...scope.customRoleIds.map((id) => `custom role ${names.customRoles.get(id) ?? id}`),
    ...scope.groupIds.map((id) => `group ${names.groups.get(id) ?? id}`),
  ];
  return `Users with ${parts.join(", ")}`;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** "in 3 days", "due today", "overdue by 2 days" for an open campaign; null otherwise. `now` keeps server and browser in step. */
export function dueText(campaign: Pick<CampaignSummary, "status" | "dueAt" | "overdue">, now?: string): string | null {
  if (campaign.status !== "open") return null;
  const reference = now ? Date.parse(now) : Date.now();
  const days = Math.ceil((Date.parse(campaign.dueAt) - reference) / DAY_MS);
  if (campaign.overdue || days < 0) {
    const late = Math.max(1, -days);
    return `overdue by ${late} day${late === 1 ? "" : "s"}`;
  }
  if (days === 0) return "due today";
  return `in ${days} day${days === 1 ? "" : "s"}`;
}

const PILL: Record<string, string> = {
  open: "bg-warn-tint text-warn",
  overdue: "bg-bad-tint text-bad",
  completed: "bg-ok-tint text-ok",
  cancelled: "bg-raise text-muted-foreground",
};

/** The campaign's state as a pill: Open with the time left, Overdue, Completed or Cancelled. */
export function CampaignStatusPill({ campaign, now }: { campaign: Pick<CampaignSummary, "status" | "dueAt" | "overdue">; now?: string }) {
  const key = campaign.status === "open" && campaign.overdue ? "overdue" : campaign.status;
  const due = dueText(campaign, now);
  const label =
    key === "overdue" ? "Overdue"
      : key === "open" ? `Open${due ? ` · ${due === "due today" ? "due today" : `due ${due}`}` : ""}`
        : key === "completed" ? "Completed" : "Cancelled";
  return (
    <span className={`inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 text-xs font-semibold tracking-normal ${PILL[key] ?? PILL.cancelled}`}>
      <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" />
      {label}
    </span>
  );
}
