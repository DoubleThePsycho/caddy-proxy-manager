// SPDX-License-Identifier: Elastic-2.0
"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AppDialog } from "@/components/ui/AppDialog";
import { Banner } from "@/components/ui/Banner";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { REPORT_TYPE_DESCRIPTIONS, REPORT_TYPE_LABELS, SELECTABLE_REPORT_TYPES, type SelectableReportType, type StoredReportDetail } from "../types";
import { callApi, Field } from "./shared";

type Preset = "last30" | "lastMonth" | "lastQuarter" | "yearToDate" | "custom";

const PRESET_LABELS: Record<Preset, string> = {
  last30: "Last 30 days",
  lastMonth: "Last calendar month",
  lastQuarter: "Last calendar quarter",
  yearToDate: "Year to date",
  custom: "Custom",
};

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** The preset period in UTC days (the API reads a bare "to" date as the end of that day). */
export function presetPeriod(preset: Exclude<Preset, "custom">, now: Date): { from: string; to: string } {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  if (preset === "last30") return { from: isoDay(new Date(now.getTime() - 30 * 86_400_000)), to: isoDay(now) };
  if (preset === "lastMonth") return { from: isoDay(new Date(Date.UTC(year, month - 1, 1))), to: isoDay(new Date(Date.UTC(year, month, 0))) };
  if (preset === "lastQuarter") {
    const quarterStart = Math.floor(month / 3) * 3;
    return { from: isoDay(new Date(Date.UTC(year, quarterStart - 3, 1))), to: isoDay(new Date(Date.UTC(year, quarterStart, 0))) };
  }
  return { from: isoDay(new Date(Date.UTC(year, 0, 1))), to: isoDay(now) };
}

/** Generates one report for a period, stores it with its SHA-256 and opens it. Needs the license. */
export default function GenerateReportDialog({ open, onClose, configurable }: { open: boolean; onClose: () => void; configurable: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [type, setType] = useState<SelectableReportType>("access_review");
  const [preset, setPreset] = useState<Preset>("last30");
  const [period, setPeriod] = useState(() => presetPeriod("last30", new Date()));
  const [error, setError] = useState<string | null>(null);

  function choosePreset(value: string) {
    const next = value as Preset;
    setPreset(next);
    if (next !== "custom") setPeriod(presetPeriod(next, new Date()));
  }

  function generate() {
    if (!period.from || !period.to) {
      setError("Choose the first and the last day of the period.");
      return;
    }
    setError(null);
    startTransition(async () => {
      try {
        const detail = await callApi<StoredReportDetail>("/reports", "POST", { type, from: period.from, to: period.to });
        toast.success(`${REPORT_TYPE_LABELS[type]} generated`);
        onClose();
        router.push(`/compliance/reports/${detail.id}`);
      } catch (err) {
        setError((err as Error).message);
      }
    });
  }

  return (
    <AppDialog open={open} onClose={onClose} title="Generate a report" maxWidth="md" submitLabel={pending ? "Generating…" : "Generate"} onSubmit={configurable ? generate : undefined} isSubmitting={pending}>
      <div className="flex flex-col gap-4">
        <Field label="Report" htmlFor="report-type">
          <Select value={type} onValueChange={(value) => setType(value as SelectableReportType)}>
            <SelectTrigger id="report-type" aria-label="Report">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SELECTABLE_REPORT_TYPES.map((value) => (
                <SelectItem key={value} value={value}>
                  {REPORT_TYPE_LABELS[value]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <p className="m-0 text-[13px] text-muted-foreground">{REPORT_TYPE_DESCRIPTIONS[type]}</p>
        <Field label="Period" htmlFor="report-preset">
          <Select value={preset} onValueChange={choosePreset}>
            <SelectTrigger id="report-preset" aria-label="Period">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(PRESET_LABELS) as Preset[]).map((value) => (
                <SelectItem key={value} value={value}>
                  {PRESET_LABELS[value]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="From (UTC)" htmlFor="report-from">
            <Input
              id="report-from"
              type="date"
              value={period.from}
              onChange={(event) => {
                setPreset("custom");
                setPeriod((current) => ({ ...current, from: event.target.value }));
              }}
            />
          </Field>
          <Field label="To (UTC, inclusive)" htmlFor="report-to">
            <Input
              id="report-to"
              type="date"
              value={period.to}
              onChange={(event) => {
                setPreset("custom");
                setPeriod((current) => ({ ...current, to: event.target.value }));
              }}
            />
          </Field>
        </div>
        <p className="m-0 text-xs text-soft">Periods span at most 366 days.</p>
        {error && (
          <Banner tone="bad" live>
            {error}
          </Banner>
        )}
      </div>
    </AppDialog>
  );
}
