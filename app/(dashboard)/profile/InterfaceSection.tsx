"use client";

import { useMemo, useState, useSyncExternalStore } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Label } from "@/components/ui/label";
import { useFormat, usePreferences } from "@/src/components/preferences/PreferencesProvider";
import {
  NUMBER_FORMATS,
  listTimeZones,
  numberFormatExample,
  type NumberFormatPreference,
  type ThemePreference,
} from "@/src/lib/preferences-shared";
import { formatNumber, formatPercent } from "@/src/lib/date-format";

const noSubscription = () => () => {};
let browserTimeZones: string[] | null = null;
const SERVER_TIME_ZONES = ["UTC"];

/** The browser's list of time zones (computed once); the server renders UTC only, so hydration matches. */
function useTimeZoneList(): string[] {
  return useSyncExternalStore(
    noSubscription,
    () => (browserTimeZones ??= listTimeZones()),
    () => SERVER_TIME_ZONES
  );
}

const THEME_LABELS: Array<[ThemePreference, string]> = [
  ["system", "System"],
  ["dark", "Dark"],
  ["light", "Light"],
];

function Segmented<T extends string>({
  labelledBy,
  options,
  value,
  onPick,
  mono = false,
  disabled = false,
}: {
  labelledBy: string;
  options: Array<[T, string]>;
  value: T;
  onPick: (value: T) => void;
  mono?: boolean;
  disabled?: boolean;
}) {
  return (
    <div role="group" aria-labelledby={labelledBy} className="inline-flex w-fit rounded-lg border bg-muted/40 p-0.5">
      {options.map(([id, label]) => (
        <button
          key={id}
          type="button"
          aria-pressed={value === id}
          onClick={() => onPick(id)}
          disabled={disabled}
          className={`rounded-md px-3 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
            value === id ? "bg-background font-medium text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
          } ${mono ? "font-mono" : ""}`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/** Profile: theme, time zone and number format of the account (src/lib/preferences.ts). */
export default function InterfaceSection() {
  const { preferences, update } = usePreferences();
  const format = useFormat();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const zoneList = useTimeZoneList();
  const timeZones = useMemo(
    () => (zoneList.includes(preferences.timeZone) ? zoneList : [preferences.timeZone, ...zoneList]),
    [zoneList, preferences.timeZone]
  );

  const save = async (change: Parameters<typeof update>[0]) => {
    setError(null);
    setPending(true);
    const problem = await update(change);
    setPending(false);
    if (problem) setError(problem);
  };

  const example = `${formatNumber(61817, preferences)} requests · ${formatPercent(0.018, preferences)} blocked`;

  return (
    <section aria-labelledby="ui-title" className="flex flex-col gap-5 rounded-xl border bg-card p-6">
      <h2 id="ui-title" className="text-base font-semibold">Interface</h2>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="flex flex-col gap-2">
          <span id="ui-theme" className="text-sm font-medium">Theme</span>
          <Segmented
            labelledBy="ui-theme"
            options={THEME_LABELS}
            value={preferences.theme}
            onPick={(theme) => save({ theme })}
            disabled={pending}
          />
          <span className="text-xs text-muted-foreground">System follows your device&apos;s setting.</span>
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="ui-tz">Time zone</Label>
          <select
            id="ui-tz"
            value={preferences.timeZone}
            onChange={(event) => save({ timeZone: event.target.value })}
            disabled={pending}
            className="flex h-9 w-full max-w-xs rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
          >
            {timeZones.map((zone) => (
              <option key={zone} value={zone}>{zone}</option>
            ))}
          </select>
          <span className="text-xs text-muted-foreground">
            Now: <span className="font-mono" suppressHydrationWarning>{format.dateTime(Date.now())}</span>
          </span>
        </div>

        <div className="flex flex-col gap-2">
          <span id="ui-nf" className="text-sm font-medium">Number format</span>
          <Segmented<NumberFormatPreference>
            labelledBy="ui-nf"
            options={NUMBER_FORMATS.map((id) => [id, numberFormatExample(id)])}
            value={preferences.numberFormat}
            onPick={(numberFormat) => save({ numberFormat })}
            mono
            disabled={pending}
          />
          <span className="text-xs text-muted-foreground">
            Example: <span className="font-mono">{example}</span>
          </span>
        </div>
      </div>
    </section>
  );
}
