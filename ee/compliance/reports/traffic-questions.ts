// SPDX-License-Identifier: Elastic-2.0
/**
 * Traffic questions report: the saved analytics questions of a report
 * schedule (ee/ai/questions), re-run for the report's period with fresh
 * data. One table per question, with the query in words and a summary the
 * dashboard writes from the figures; no AI model is asked when a report is
 * generated, so the report is the same however often it is checked.
 *
 * Like every compliance report it covers every host: host tags name every
 * proxy host that carries them when the report is generated. The stored
 * query is validated again before it runs, with bound parameters only.
 */
import { appDb } from "@/src/lib/db";
import { proxyHosts } from "@/src/lib/db/schema";
import { parseStoredTags } from "@/src/lib/host-tags";
import { getRetentionDays } from "@/src/lib/clickhouse/client";
import { parseDomains } from "@/src/lib/analytics/scope";
import { seenHosts } from "@/ee/multi-tenancy/analytics";
import { computedSummary, describeQuery, formatPeriod } from "@/ee/ai/questions/describe";
import { runQuestionQuery, type QuestionScope } from "@/ee/ai/questions/run";
import { parseQuestionQuery } from "@/ee/ai/questions/schema";
import { QUESTION_DIMENSION_LABELS, QUESTION_METRIC_LABELS, type QuestionDimension, type QuestionQuery, type QuestionResult } from "@/ee/ai/questions/types";
import { clean, columns, finding, section, summaryItem, type ReportBuilder } from "./shared";
import type { ReportCell, ReportFinding, ReportSection } from "../types";

const DAY = 86_400;

/** Every proxy host, for host tags: a report covers every host. */
async function reportScope(): Promise<QuestionScope> {
  const hosts = (await appDb
    .select({ id: proxyHosts.id, domains: proxyHosts.domains, tags: proxyHosts.tags })
    .from(proxyHosts))
    .map((row) => ({ id: row.id, domains: parseDomains(row.domains), tags: parseStoredTags(row.tags) }));
  return {
    hostScope: null,
    taggableHosts: hosts,
    allHosts: hosts.map(({ id, domains }) => ({ id, domains })),
    seenHosts,
    audience: "report",
  };
}

const percent = (fraction: number | null) => (fraction === null ? null : Math.round(fraction * 1000) / 10);

function unanswered(key: string, question: string, why: string): ReportSection {
  return section(key, clean(question, 300), why, columns([["status", "Status"]]), [{ status: "Not answered" }]);
}

function totalSection(key: string, title: string, description: string, result: QuestionResult): ReportSection {
  const compared = result.previous !== null;
  const cols: [string, string][] = [["measure", "Measure"], ["value", "Value"]];
  if (compared) cols.push(["previous", "Previous period"], ["change", "Change (%)"]);
  const row: Record<string, ReportCell> = { measure: QUESTION_METRIC_LABELS[result.metric], value: result.total };
  if (compared) {
    row.previous = result.previousTotal;
    row.change = percent(result.change);
  }
  return section(key, title, description, columns(cols), [row]);
}

/** The series by day (UTC): buckets are an hour or less, so each falls in one day. */
function seriesSection(key: string, title: string, description: string, result: QuestionResult): ReportSection {
  const byDay = new Map<number, number>();
  (result.series?.values ?? []).forEach((value, index) => {
    const start = result.range.start + index * result.range.step;
    const dayStart = Math.max(result.range.start, Math.floor(start / DAY) * DAY);
    byDay.set(dayStart, (byDay.get(dayStart) ?? 0) + value);
  });
  const rows = [...byDay.entries()].map(([start, value]) => ({ from: new Date(start * 1000).toISOString(), value }));
  return section(key, title, description, columns([["from", "From (UTC)"], ["value", QUESTION_METRIC_LABELS[result.metric]]]), rows);
}

function breakdownSection(key: string, title: string, description: string, query: QuestionQuery, result: QuestionResult): ReportSection {
  const compared = result.previous !== null && result.previous.available;
  const dimension = QUESTION_DIMENSION_LABELS[query.breakdown as QuestionDimension];
  const cols: [string, string][] = [
    ["rank", "#"],
    ["value", dimension.charAt(0).toUpperCase() + dimension.slice(1)],
    ["name", "Name"],
    ["count", QUESTION_METRIC_LABELS[result.metric]],
    ["share", "Share (%)"],
  ];
  if (compared) cols.push(["previous", "Previous period"], ["change", "Change (%)"]);
  const rows = result.rows.map((row, index) => {
    const cells: Record<string, ReportCell> = {
      rank: index + 1,
      value: clean(row.value, 300),
      name: row.label ? clean(row.label, 200) : null,
      count: row.count,
      share: percent(row.share),
    };
    if (compared) {
      cells.previous = row.previous;
      cells.change = percent(row.change);
    }
    return cells;
  });
  return section(key, title, description, columns(cols), rows);
}

export const buildTrafficQuestions: ReportBuilder = async (context) => {
  const questions = context.questions ?? [];
  const start = Math.floor(context.period.from.getTime() / 1000);
  // The period's `to` is its last millisecond.
  const end = Math.ceil((context.period.to.getTime() + 1) / 1000);
  const now = Math.floor(context.now.getTime() / 1000);
  const enabled = context.analytics.analyticsEnabled();
  const scope = await reportScope();
  const sections: ReportSection[] = [];
  const findings: ReportFinding[] = [];
  let answered = 0;

  for (const [index, item] of questions.entries()) {
    const key = `question_${index + 1}`;
    const title = clean(item.question, 300) || `Question ${index + 1}`;
    const miss = (why: string) => {
      sections.push(unanswered(key, title, why));
      findings.push(finding("info", "question_not_answered", `question:${index + 1}`, `"${title.slice(0, 120)}" was not answered: ${why}`));
    };
    let query: QuestionQuery;
    try {
      query = parseQuestionQuery(item.query);
    } catch {
      miss("its stored query is no longer valid; replace the question in the schedule.");
      continue;
    }
    if (!enabled) {
      miss("ClickHouse analytics is not configured.");
      continue;
    }
    const run = await runQuestionQuery(query, scope, { now, period: { start, end } });
    if (run.kind === "clarify") {
      miss(run.message);
      continue;
    }
    const { result, range } = run;
    if (result.status !== "ok") {
      miss("ClickHouse did not answer.");
      continue;
    }
    answered += 1;
    const description = [
      `${describeQuery(query, range)}.`,
      computedSummary(result, formatPeriod(range.start, range.end)),
      ...result.notes,
    ].join(" ");
    if (result.kind === "breakdown") sections.push(breakdownSection(key, title, description, query, result));
    else if (result.kind === "series" && result.metric !== "visitors") sections.push(seriesSection(key, title, description, result));
    else sections.push(totalSection(key, title, description, result));
  }

  return {
    summary: [
      summaryItem("questions", "Questions", questions.length),
      summaryItem("answered", "Answered", answered),
      summaryItem("notAnswered", "Not answered", questions.length - answered),
    ],
    findings,
    sections,
    notes: [
      "Each question was re-run for the report's period over every host; host tags name every proxy host that carries them when the report was generated.",
      "The summaries are written by the dashboard from the figures; no AI model is asked when a report is generated.",
      `Traffic figures come from ClickHouse analytics, which keep ${getRetentionDays()} days.`,
      ...(questions.length === 0 ? ["The schedule has no questions."] : []),
    ],
  };
};
