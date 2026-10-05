import Link from "next/link";
import type { WafSettingsPageData } from "./waf-settings-shared";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmt = (value: number) => value.toLocaleString("en-US");

/** The seven UTC days ending today, labelled "27 Sep" at the start and at a new month, else by day. */
function lastSevenDays(to: number, daily: { day: string; count: number }[]): { label: string; count: number; key: string }[] {
  const counts = new Map(daily.map((row) => [row.day, row.count]));
  const days: { label: string; count: number; key: string }[] = [];
  let previousMonth = -1;
  for (let offset = 6; offset >= 0; offset--) {
    const date = new Date((to - offset * 86_400) * 1000);
    const key = date.toISOString().slice(0, 10);
    const month = date.getUTCMonth();
    const label = previousMonth === month ? String(date.getUTCDate()) : `${date.getUTCDate()} ${MONTHS[month]}`;
    previousMonth = month;
    days.push({ label, count: counts.get(key) ?? 0, key });
  }
  return days;
}

/** "What the rules stopped": WAF events per day and the busiest rules of the last 7 days. */
export function WafRulesStopped({ week, analyticsEnabled }: { week: WafSettingsPageData["week"]; analyticsEnabled: boolean }) {
  const days = lastSevenDays(week.to, week.daily);
  const max = Math.max(1, ...days.map((day) => day.count));
  const top = week.topRules;
  const topMax = Math.max(1, ...top.map((rule) => rule.count));
  const shownEvents = top.reduce((sum, rule) => sum + rule.count, 0);
  const moreRules = Math.max(0, week.summary.rules - top.length);
  const moreEvents = Math.max(0, week.summary.total - shownEvents);
  const chartLabel = `WAF events per day: ${days.map((day) => `${day.label} ${fmt(day.count)}`).join(", ")}`;

  return (
    <section aria-labelledby="waf-stopped-title" className="flex min-w-0 flex-[1_1_320px] flex-col overflow-hidden rounded-xl border bg-card">
      <div className="flex flex-col gap-0.5 px-4 pb-3 pt-3.5">
        <div className="flex items-center gap-2.5">
          <h2 id="waf-stopped-title" className="text-base font-semibold">What the rules stopped</h2>
          <Link href="/security?range=7d&kind=waf" className="ml-auto text-sm text-primary hover:underline">Events</Link>
        </div>
        <span className="text-sm text-muted-foreground">
          {analyticsEnabled
            ? `Last 7 days · ${fmt(week.summary.rules)} ${week.summary.rules === 1 ? "rule" : "rules"} on ${fmt(week.summary.hosts)} ${week.summary.hosts === 1 ? "host" : "hosts"}`
            : "Analytics are off."}
        </span>
      </div>
      {analyticsEnabled && (
        <>
          <div className="px-4 pb-3.5 pt-1">
            <div role="img" aria-label={chartLabel} className="flex h-[76px] items-end gap-1.5">
              {days.map((day) => (
                <div key={day.key} className="flex h-full min-w-0 flex-1 flex-col items-stretch justify-end gap-1">
                  <span className="text-center font-mono text-[11px] leading-[14px] text-muted-foreground">{fmt(day.count)}</span>
                  <div
                    data-series="waf"
                    className="min-h-[2px] rounded-t-[3px] bg-destructive/70"
                    style={{ height: `${((day.count / max) * 56).toFixed(1)}px` }}
                  />
                </div>
              ))}
            </div>
            <div className="mt-1.5 flex gap-1.5 border-t pt-1.5" aria-hidden="true">
              {days.map((day) => (
                <span key={day.key} className="min-w-0 flex-1 whitespace-nowrap text-center font-mono text-[11px] text-muted-foreground">
                  {day.label}
                </span>
              ))}
            </div>
          </div>
          {top.length === 0 ? (
            <p className="border-t px-4 py-3 text-sm text-muted-foreground">No rule matched in the last 7 days.</p>
          ) : (
            <ol className="border-t">
              {top.map((rule) => (
                <li key={rule.ruleId} className="flex flex-col gap-1.5 border-b px-4 py-2.5">
                  <span className="flex items-center gap-2 text-sm">
                    <span className="shrink-0 rounded bg-muted px-1.5 font-mono text-xs leading-[18px] text-muted-foreground">{rule.ruleId}</span>
                    <span className="min-w-0 flex-1 truncate">{rule.message ?? "No message recorded"}</span>
                    <span className="font-mono">{fmt(rule.count)}</span>
                  </span>
                  <span className="block h-1 rounded-sm bg-muted" aria-hidden="true">
                    <span
                      data-series="waf"
                      className="block h-1 rounded-sm bg-destructive/70"
                      style={{ width: `${Math.max(1, (rule.count / topMax) * 100).toFixed(1)}%` }}
                    />
                  </span>
                </li>
              ))}
            </ol>
          )}
          {moreRules > 0 && (
            <div className="px-4 pb-3 pt-2.5 text-sm text-muted-foreground">
              <span className="font-mono">{fmt(moreRules)}</span> more {moreRules === 1 ? "rule" : "rules"}, <span className="font-mono">{fmt(moreEvents)}</span> events
            </div>
          )}
        </>
      )}
    </section>
  );
}
