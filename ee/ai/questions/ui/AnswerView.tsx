// SPDX-License-Identifier: Elastic-2.0
"use client";

/**
 * One answer to a plain-language question: what the question was read as
 * (with a link that opens it on the Analytics page), the summary (labelled
 * when the model wrote it), the result as a figure, a chart over time or a
 * ranked list, notes, and what was sent to the AI provider. Values come
 * from requests and are rendered as text.
 */
import type { ReactNode } from "react";
import Link from "next/link";
import { ExternalLink, Info } from "lucide-react";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/button";
import { KpiTile } from "@/components/ui/KpiTile";
import { StackedBarChart } from "@/components/ui/StackedBarChart";
import { TopList, type TopListRow } from "@/components/ui/TopList";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatBytes, formatChange, formatCompact, formatPercent, type GoodDirection } from "@/components/ui/chart-format";
import { AI_GENERATED_SUMMARY_LABEL } from "@/ee/ai/types";
import { OUTCOME_WORDS, durationWords } from "../describe";
import { QUESTION_DIMENSION_LABELS, QUESTION_METRIC_LABELS, type QuestionAnswer, type QuestionDimension, type QuestionResult } from "../types";

const METRIC_COLOR: Record<string, string> = {
  requests: "var(--served)",
  bytes: "var(--served2)",
  visitors: "var(--brand)",
  mitigated: "var(--waf)",
  errors: "var(--err5)",
};

const GOOD: Record<string, GoodDirection> = { requests: null, bytes: null, visitors: null, mitigated: "down", errors: "down" };

let regionNames: Intl.DisplayNames | null | undefined;

function countryName(code: string): string {
  if (code === "LAN") return "Private network";
  if (code === "XX" || !code) return "Unknown";
  if (regionNames === undefined) {
    try {
      regionNames = new Intl.DisplayNames(["en"], { type: "region" });
    } catch {
      regionNames = null;
    }
  }
  try {
    return regionNames?.of(code) ?? code;
  } catch {
    return code;
  }
}

function formatter(result: QuestionResult): (value: number) => string {
  return result.unit === "bytes" ? formatBytes : formatCompact;
}

function rowLabel(result: QuestionResult, value: string, label: string | null): { label: string; sub?: string; code?: string } {
  switch (result.breakdown) {
    case "country":
      return { label: countryName(value), code: value };
    case "asn":
      return { label: value === "0" || !value ? "Unknown network" : `AS${value}`, sub: label ?? undefined };
    case "outcome":
      return { label: OUTCOME_WORDS[value] ? OUTCOME_WORDS[value].charAt(0).toUpperCase() + OUTCOME_WORDS[value].slice(1) : value };
    case "waf_rule":
      return { label: `Rule ${value}`, sub: label ?? undefined };
    case "ip":
      return { label: value, sub: label ?? undefined };
    default:
      return { label: value || "(empty)", sub: label ?? undefined };
  }
}

function ResultView({ result }: { result: QuestionResult }) {
  const format = formatter(result);
  if (result.status === "disabled") {
    return <Banner tone="warn">Traffic analytics is not configured, so there is no traffic data to answer from.</Banner>;
  }
  if (result.status === "unavailable") {
    return <Banner tone="warn">ClickHouse did not answer, so the numbers could not be read. Try again later.</Banner>;
  }
  const label = QUESTION_METRIC_LABELS[result.metric];
  const comparing = result.previous !== null;
  const previousText = result.previous?.available ? `vs the ${durationWords(result.range.end - result.range.start)} before` : "No earlier data in the retention";

  if (result.kind === "breakdown") {
    const dimension = QUESTION_DIMENSION_LABELS[result.breakdown as QuestionDimension];
    if (!comparing || !result.previous?.available) {
      const rows: TopListRow[] = result.rows.map((row, index) => ({ key: `${index}:${row.value}`, count: row.count, ...rowLabel(result, row.value, row.label) }));
      return (
        <TopList
          title={`${label} by ${dimension}`}
          unit={label}
          rows={rows}
          total={result.total}
          mono={["path", "ip", "host", "user_agent", "status", "waf_rule", "asn"].includes(result.breakdown)}
          formatCount={format}
          emptyText="Nothing matches in this period."
        />
      );
    }
    return (
      <div className="overflow-x-auto rounded-xl border border-line bg-panel">
        <Table className="min-w-[560px]">
          <TableHeader>
            <TableRow>
              <TableHead scope="col">{dimension.charAt(0).toUpperCase() + dimension.slice(1)}</TableHead>
              <TableHead scope="col" className="text-right">{label}</TableHead>
              <TableHead scope="col" className="text-right">Share</TableHead>
              <TableHead scope="col" className="text-right">Previous period</TableHead>
              <TableHead scope="col" className="text-right">Change</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {result.rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-soft">Nothing matches in this period.</TableCell>
              </TableRow>
            ) : (
              result.rows.map((row, index) => {
                const named = rowLabel(result, row.value, row.label);
                const change = formatChange(row.count, row.previous, GOOD[result.metric]);
                return (
                  <TableRow key={`${index}:${row.value}`}>
                    <TableCell className="max-w-[420px] [overflow-wrap:anywhere]">
                      <span className="font-medium">{named.label}</span>
                      {named.sub && <span className="ml-2 text-xs text-soft">{named.sub}</span>}
                    </TableCell>
                    <TableCell className="num text-right">{format(row.count)}</TableCell>
                    <TableCell className="num text-right">{formatPercent(row.share)}</TableCell>
                    <TableCell className="num text-right">{row.previous === null ? "–" : format(row.previous)}</TableCell>
                    <TableCell className={`num text-right ${change.tone === "bad" ? "text-bad" : change.tone === "ok" ? "text-ok" : "text-muted-foreground"}`}>
                      {row.previous === null ? "–" : change.text}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>
    );
  }

  const change = formatChange(result.total, result.previousTotal, GOOD[result.metric]);
  const tile = (
    <KpiTile
      label={label}
      value={format(result.total)}
      color={METRIC_COLOR[result.metric]}
      delta={comparing ? { text: change.text, tone: change.tone } : undefined}
      note={comparing ? previousText : undefined}
      className="max-w-[320px]"
    />
  );
  if (result.kind === "total" || !result.series) return tile;
  const buckets = result.series.values.map((_, index) => (result.range.start + index * result.range.step) * 1000);
  return (
    <div className="flex flex-col gap-3">
      {tile}
      <StackedBarChart
        title={`${label} over time`}
        buckets={buckets}
        stepSeconds={result.range.step}
        series={[{ key: result.metric, label, color: METRIC_COLOR[result.metric], values: result.series.values }]}
        previous={result.series.previous ?? undefined}
        previousLabel="Previous period"
        legend={false}
        formatValue={format}
        emptyText="Nothing in this period."
        height={220}
      />
    </div>
  );
}

export type AnswerViewProps = {
  answer: QuestionAnswer;
  /** Shown when the answer can be saved. */
  saveSlot?: ReactNode;
};

export function AnswerView({ answer, saveSlot }: AnswerViewProps) {
  if (answer.status === "clarify") {
    return (
      <Banner tone="info" title="Which do you mean?" live>
        {answer.message}
      </Banner>
    );
  }
  if (answer.status === "unsupported") {
    return (
      <Banner tone="warn" title="Not answered." live>
        {answer.message}
      </Banner>
    );
  }
  const result = answer.result;
  return (
    <div className="flex min-w-0 flex-col gap-3.5" data-testid="question-answer">
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
        <p className="m-0 min-w-0 flex-[1_1_320px] text-[13px] text-muted-foreground [overflow-wrap:anywhere]">
          <span className="font-medium text-foreground">Read as: </span>
          {answer.interpretation}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {answer.analyticsHref && (
            <Button asChild variant="outline" size="sm">
              <Link href={answer.analyticsHref}>
                <ExternalLink aria-hidden="true" />
                Open in Analytics
              </Link>
            </Button>
          )}
          {saveSlot}
        </div>
      </div>

      {answer.summary && (
        <div role="status" className="rounded-xl border border-line bg-panel2 px-3.5 py-3 text-[13px]">
          <span className="font-semibold">{answer.summary.source === "ai" ? `${AI_GENERATED_SUMMARY_LABEL}: ` : "Summary: "}</span>
          <span className="text-muted-foreground [overflow-wrap:anywhere]">{answer.summary.text}</span>
          {answer.summaryError && (
            <span className="mt-1 block text-xs text-soft">The AI summary failed ({answer.summaryError}); the dashboard wrote this one from the numbers.</span>
          )}
        </div>
      )}

      {result && <ResultView result={result} />}

      {result && result.notes.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-1 p-0 text-xs text-soft">
          {result.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}

      {answer.privacy && (
        <p className="m-0 flex items-start gap-1.5 text-xs text-soft">
          <Info className="mt-px size-3.5 shrink-0" aria-hidden="true" />
          <span>{answer.privacy.description}</span>
        </p>
      )}
    </div>
  );
}
