// SPDX-License-Identifier: Elastic-2.0
/**
 * The record of a campaign, as CSV or JSON: every item with its decision,
 * reviewer, times and outcome. Available for open campaigns too (an interim
 * record); a completed campaign's record is final.
 */
import { ApiValidationError } from "@/src/lib/api-errors";
import { csvCell } from "@/ee/audit/export";
import { getCampaign } from "./campaigns";
import { ITEM_KIND_LABELS, type CampaignDetail } from "./types";

export const RECORD_FORMATS = ["csv", "json"] as const;
export type RecordFormat = (typeof RECORD_FORMATS)[number];

export function readRecordFormat(params: URLSearchParams): RecordFormat {
  const format = (params.get("format") ?? "csv").trim().toLowerCase();
  if (format !== "csv" && format !== "json") throw new ApiValidationError("format must be csv or json");
  return format;
}

const CSV_COLUMNS = [
  "campaign_id",
  "campaign_name",
  "campaign_status",
  "due_at",
  "user_id",
  "user_email",
  "user_name",
  "access_type",
  "access",
  "decision",
  "comment",
  "reviewer_email",
  "decided_at",
  "confirmed_at",
  "outcome",
  "outcome_detail",
] as const;

function csv(campaign: CampaignDetail): string {
  const lines = [CSV_COLUMNS.join(",")];
  for (const item of campaign.items) {
    const row: Record<(typeof CSV_COLUMNS)[number], string | number | null> = {
      campaign_id: campaign.id,
      campaign_name: campaign.name,
      campaign_status: campaign.status,
      due_at: campaign.dueAt,
      user_id: item.subjectUserId,
      user_email: item.subjectEmail,
      user_name: item.subjectName,
      access_type: ITEM_KIND_LABELS[item.kind] ?? item.kind,
      access: item.targetLabel,
      decision: item.decision,
      comment: item.comment,
      reviewer_email: item.decidedByEmail,
      decided_at: item.decidedAt,
      confirmed_at: item.confirmedAt,
      outcome: item.outcome ?? (campaign.status === "open" ? "pending" : null),
      outcome_detail: item.outcomeDetail,
    };
    lines.push(CSV_COLUMNS.map((column) => csvCell(row[column])).join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}

function fileName(campaign: CampaignDetail, format: RecordFormat): string {
  const slug = campaign.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "review";
  return `access-review-${campaign.id}-${slug}.${format}`;
}

export async function buildRecord(id: number, format: RecordFormat): Promise<{ body: string; contentType: string; fileName: string }> {
  const campaign = await getCampaign(id);
  if (format === "json") {
    const { items, ...summary } = campaign;
    return {
      body: JSON.stringify({ generatedAt: new Date().toISOString(), campaign: summary, items }, null, 2),
      contentType: "application/json; charset=utf-8",
      fileName: fileName(campaign, format),
    };
  }
  return { body: csv(campaign), contentType: "text/csv; charset=utf-8", fileName: fileName(campaign, format) };
}
