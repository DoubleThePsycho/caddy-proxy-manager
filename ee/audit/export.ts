// SPDX-License-Identifier: Elastic-2.0
/**
 * Audit log export as CSV or JSON, streamed in id order so large logs never
 * sit in memory. Exports include the hash chain fields, so a copy can be
 * verified offline (see ee/docs/audit-streaming.md).
 */
import { logAuditEvent } from "@/src/lib/audit";
import { ApiValidationError } from "@/src/lib/api-errors";
import { AUDIT_CHAIN_VERSION } from "@/src/lib/audit-chain";
import { requireFeature } from "@/ee/licensing/store";
import { latestAuditEventId, readAuditRecords, type AuditRecord } from "./records";

export const EXPORT_FORMATS = ["csv", "json"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];
const PAGE_SIZE = 500;

export type ExportQuery = { format: ExportFormat; from: string | null; to: string | null };

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

function parseInstant(value: string, label: string, endOfDay: boolean): string {
  const trimmed = value.trim();
  if (trimmed.length > 40) throw new ApiValidationError(`${label} must be an ISO 8601 date or date-time`);
  const isDate = DATE_ONLY.test(trimmed);
  const ms = Date.parse(isDate ? `${trimmed}T00:00:00.000Z` : trimmed);
  if (Number.isNaN(ms) || !(isDate || /^\d{4}-\d{2}-\d{2}T/.test(trimmed))) {
    throw new ApiValidationError(`${label} must be an ISO 8601 date or date-time`);
  }
  // A bare date as the upper bound includes the whole day.
  return new Date(isDate && endOfDay ? ms + DAY_MS - 1 : ms).toISOString();
}

export function parseExportQuery(params: URLSearchParams): ExportQuery {
  const format = (params.get("format") ?? "csv").trim().toLowerCase();
  if (!(EXPORT_FORMATS as readonly string[]).includes(format)) {
    throw new ApiValidationError("format must be csv or json");
  }
  const fromRaw = params.get("from");
  const toRaw = params.get("to");
  const from = fromRaw ? parseInstant(fromRaw, "from", false) : null;
  const to = toRaw ? parseInstant(toRaw, "to", true) : null;
  if (from && to && from > to) throw new ApiValidationError("from must not be after to");
  return { format: format as ExportFormat, from, to };
}

const CSV_COLUMNS = [
  "id",
  "createdAt",
  "userId",
  "userEmail",
  "userName",
  "action",
  "entityType",
  "entityId",
  "summary",
  "data",
  "prevHash",
  "hash",
  "actorDigest",
] as const satisfies readonly (keyof AuditRecord)[];

/**
 * One CSV field. Text that a spreadsheet would run as a formula (starting
 * with = + - @, tab or carriage return) gets a leading apostrophe.
 */
export function csvCell(value: string | number | null): string {
  if (value === null) return "";
  let text = String(value);
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function csvRow(record: AuditRecord): string {
  return `${CSV_COLUMNS.map((column) => csvCell(record[column])).join(",")}\r\n`;
}

function jsonRecord(record: AuditRecord): string {
  const ordered: Record<string, unknown> = {};
  for (const column of CSV_COLUMNS) ordered[column] = record[column];
  return JSON.stringify(ordered);
}

/** The export body. Events recorded after the export started are not included. */
export function createAuditExportStream(query: ExportQuery, now: Date = new Date()): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let afterId = 0;
  let maxId: number | null = null;
  let first = true;
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      maxId = await latestAuditEventId();
      if (query.format === "csv") {
        controller.enqueue(encoder.encode(`${CSV_COLUMNS.join(",")}\r\n`));
      } else {
        const header = {
          exportedAt: now.toISOString(),
          from: query.from,
          to: query.to,
          hashChain: { version: AUDIT_CHAIN_VERSION, algorithm: "sha256" },
        };
        controller.enqueue(encoder.encode(`${JSON.stringify(header).slice(0, -1)},"events":[`));
      }
    },
    async pull(controller) {
      const records = await readAuditRecords(afterId, PAGE_SIZE, { from: query.from, to: query.to, maxId });
      if (records.length === 0) {
        if (query.format === "json") controller.enqueue(encoder.encode("\n]}\n"));
        controller.close();
        return;
      }
      afterId = records[records.length - 1].id;
      let chunk = "";
      for (const record of records) {
        if (query.format === "csv") {
          chunk += csvRow(record);
        } else {
          chunk += `${first ? "" : ","}\n${jsonRecord(record)}`;
          first = false;
        }
      }
      controller.enqueue(encoder.encode(chunk));
    },
  });
}

export type AuditExport = {
  body: ReadableStream<Uint8Array>;
  filename: string;
  contentType: string;
};

/** Checks the license, records the export in the audit log and returns the stream. */
export async function exportAuditLog(params: URLSearchParams, actorUserId: number, now: Date = new Date()): Promise<AuditExport> {
  await requireFeature("audit_streaming");
  const query = parseExportQuery(params);
  await logAuditEvent({
    userId: actorUserId,
    action: "audit_log_exported",
    entityType: "audit_log",
    summary: `Exported the audit log as ${query.format.toUpperCase()}`,
    data: { format: query.format, from: query.from, to: query.to },
  });
  const stamp = now.toISOString().replace(/\.\d+Z$/, "Z").replace(/:/g, "-");
  return {
    body: createAuditExportStream(query, now),
    filename: `audit-log-${stamp}.${query.format}`,
    contentType: query.format === "csv" ? "text/csv; charset=utf-8" : "application/json; charset=utf-8",
  };
}
