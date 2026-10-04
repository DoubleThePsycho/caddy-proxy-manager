"use server";

import { requirePermission } from "@/src/lib/auth";
import { getWafEventByEventId, isWafEventId } from "@/src/lib/models/waf-events";

export type AuditRecordResult = { ok: true; value: string } | { ok: false; error: string };

/** Longest audit record shown on the page; the rest is cut (GET /api/waf-events returns all of it). */
const MAX_RECORD_CHARS = 200_000;

/**
 * The stored Coraza audit record of a WAF event, pretty-printed: the Raw
 * audit record view of an event on the Security events page. Credential
 * values were redacted when the event was ingested (waf-log-parser.ts).
 */
export async function wafAuditRecordAction(eventId: string): Promise<AuditRecordResult> {
  await requirePermission("waf:read");
  if (typeof eventId !== "string" || !isWafEventId(eventId)) return { ok: false, error: "This is not a WAF event id." };
  const event = await getWafEventByEventId(eventId);
  if (!event) return { ok: false, error: "This event is no longer stored." };
  if (!event.rawData) return { ok: false, error: "No audit record was stored with this event." };
  let text = event.rawData;
  try {
    text = JSON.stringify(JSON.parse(event.rawData), null, 2);
  } catch {
    // Not JSON: shown as stored.
  }
  return { ok: true, value: text.length > MAX_RECORD_CHARS ? `${text.slice(0, MAX_RECORD_CHARS)}\n…` : text };
}
