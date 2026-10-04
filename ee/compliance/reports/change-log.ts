// SPDX-License-Identifier: Elastic-2.0
/**
 * Change log: the audit events of the period grouped by area and actor, and
 * the result of verifying the audit log's hash chain (src/lib/audit-chain.ts,
 * ee/audit/verify.ts) at generation time. Event `data` is left out: summaries
 * describe each change, and the full events (with their hashes) are in the
 * audit log export.
 */
import { verifyAuditChain } from "@/ee/audit/verify";
import { getAuditRetention } from "@/ee/audit/retention";
import { auditArea, classifyAuditAction, type AuditEventKind } from "../audit-areas";
import {
  auditActor,
  auditEventsInPeriod,
  clean,
  columns,
  DAY_MS,
  finding,
  iso,
  keyValueSection,
  section,
  sortFindings,
  summaryItem,
  type BuildContext,
  type BuiltReport,
} from "./shared";
import type { ReportFinding } from "../types";

/** Events listed one by one; the grouped tables and counts always cover the whole period. */
export const MAX_LISTED_EVENTS = 5000;
/** Events read for grouping (a period with more is summarised from the first ones and says so). */
const MAX_GROUPED_EVENTS = 50_000;

type Tally = { events: number; changes: number; signIns: number; other: number };

function tally(target: Tally, kind: AuditEventKind) {
  target.events += 1;
  if (kind === "change") target.changes += 1;
  else if (kind === "sign-in") target.signIns += 1;
  else target.other += 1;
}

function actionCounts(map: Map<string, number>): string[] {
  return [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([action, n]) => `${action} ×${n}`);
}

export async function buildChangeLog(context: BuildContext): Promise<BuiltReport> {
  const events = await auditEventsInPeriod(context.period, { limit: MAX_GROUPED_EVENTS });
  const verification = await verifyAuditChain(context.now);
  const retention = await getAuditRetention();

  const totals: Tally = { events: 0, changes: 0, signIns: 0, other: 0 };
  const areas = new Map<string, Tally & { entityTypes: Set<string>; actors: Set<string>; actions: Map<string, number> }>();
  const actors = new Map<string, Tally & { userId: number | null; areas: Set<string>; firstAt: string; lastAt: string }>();
  let unchained = 0;

  const eventRows = events.rows.map((row) => {
    const kind = classifyAuditAction(row.action);
    const area = auditArea(row.entityType);
    const actor = auditActor(row);
    const at = iso(row.createdAt) ?? row.createdAt;
    tally(totals, kind);
    if (row.hash === null) unchained += 1;

    const areaEntry = areas.get(area) ?? { events: 0, changes: 0, signIns: 0, other: 0, entityTypes: new Set(), actors: new Set(), actions: new Map() };
    tally(areaEntry, kind);
    areaEntry.entityTypes.add(clean(row.entityType, 80));
    areaEntry.actors.add(actor);
    areaEntry.actions.set(clean(row.action, 80), (areaEntry.actions.get(clean(row.action, 80)) ?? 0) + 1);
    areas.set(area, areaEntry);

    const actorKey = row.userId === null ? "system" : `user:${row.userId}`;
    const actorEntry = actors.get(actorKey) ?? { events: 0, changes: 0, signIns: 0, other: 0, userId: row.userId, areas: new Set(), firstAt: at, lastAt: at };
    tally(actorEntry, kind);
    actorEntry.areas.add(area);
    if (at < actorEntry.firstAt) actorEntry.firstAt = at;
    if (at > actorEntry.lastAt) actorEntry.lastAt = at;
    actors.set(actorKey, actorEntry);

    return {
      id: row.id,
      at,
      actor,
      kind,
      area,
      action: clean(row.action, 80),
      entityType: clean(row.entityType, 80),
      entityId: row.entityId,
      summary: clean(row.summary ?? "", 500),
      chained: row.hash !== null,
    };
  });

  const actorLabels = new Map(events.rows.map((row) => [row.userId === null ? "system" : `user:${row.userId}`, auditActor(row)]));
  const findings: ReportFinding[] = [];
  if (!verification.ok) {
    findings.push(
      finding(
        "high",
        "audit_chain_broken",
        `audit_event:${verification.firstMismatchId}`,
        `The audit log's hash chain does not verify at event #${verification.firstMismatchId}: ${verification.reason ?? "mismatch"}. Events from there on may have been changed, removed or inserted.`
      )
    );
  }
  if (unchained > 0) {
    findings.push(
      finding(
        "medium",
        "audit_events_unchained",
        "audit_log",
        `${unchained} event${unchained === 1 ? "" : "s"} in the period carry no hash (recorded before the hash chain existed) and are not covered by the verification.`
      )
    );
  }
  if (retention.days > 0 && context.period.from.getTime() < context.now.getTime() - retention.days * DAY_MS) {
    findings.push(
      finding(
        "low",
        "audit_retention_shorter_than_period",
        "audit_log",
        `Audit retention keeps ${retention.days} days, so events from the start of the period may already have been deleted.`
      )
    );
  }
  if (events.total > events.rows.length) {
    findings.push(
      finding(
        "info",
        "change_log_partial",
        "audit_log",
        `The period has ${events.total} events; the grouped tables cover the first ${events.rows.length}. Choose a shorter period for a complete summary.`
      )
    );
  }

  const areaRows = [...areas.entries()]
    .sort((a, b) => b[1].events - a[1].events || a[0].localeCompare(b[0]))
    .map(([area, entry]) => ({
      area,
      entityTypes: [...entry.entityTypes].sort(),
      events: entry.events,
      changes: entry.changes,
      signIns: entry.signIns,
      other: entry.other,
      actors: entry.actors.size,
      actions: actionCounts(entry.actions),
    }));
  const actorRows = [...actors.entries()]
    .sort((a, b) => b[1].events - a[1].events || a[0].localeCompare(b[0]))
    .map(([key, entry]) => ({
      actor: actorLabels.get(key) ?? key,
      userId: entry.userId,
      events: entry.events,
      changes: entry.changes,
      signIns: entry.signIns,
      other: entry.other,
      areas: [...entry.areas].sort(),
      firstAt: entry.firstAt,
      lastAt: entry.lastAt,
    }));

  return {
    summary: [
      summaryItem("events", "Audit events in the period", events.total),
      summaryItem("changes", "Changes", totals.changes),
      summaryItem("signIns", "Sign-in events", totals.signIns),
      summaryItem("other", "Other events (exports, tests, verifications, reports)", totals.other),
      summaryItem("actors", "Actors", actors.size),
      summaryItem("areas", "Areas", areas.size),
      summaryItem("chainVerified", "Audit log hash chain verified", verification.ok),
      summaryItem("chainCheckedEvents", "Chained events checked", verification.checked),
      summaryItem("unchainedEventsInPeriod", "Events in the period without a hash", unchained),
    ],
    findings: sortFindings(findings),
    sections: [
      keyValueSection(
        "integrity",
        "Audit log integrity",
        "Verification of the whole audit log's hash chain at generation time. Keep the head hash: a later copy whose chain does not contain it has lost events.",
        [
          ["Result", verification.ok ? "intact" : "broken"],
          ["Chained events checked", verification.checked],
          ["First mismatching event", verification.firstMismatchId],
          ["Reason", verification.reason],
          ["Anchor event (oldest remaining chained event)", verification.anchorId],
          ["Anchored at (UTC)", verification.anchoredAt],
          ["Anchor previous hash", verification.anchorHash],
          ["Head event (newest chained event)", verification.headId],
          ["Head hash", verification.headHash],
          ["Events before the hash chain existed (whole log)", verification.unchainedEvents],
          ["Verified at (UTC)", verification.verifiedAt],
          ["Audit retention (days, 0 keeps every event)", retention.days],
        ]
      ),
      section(
        "by_area",
        "Events by area",
        null,
        columns([
          ["area", "Area"],
          ["entityTypes", "Entity types"],
          ["events", "Events"],
          ["changes", "Changes"],
          ["signIns", "Sign-ins"],
          ["other", "Other"],
          ["actors", "Actors"],
          ["actions", "Actions"],
        ]),
        areaRows
      ),
      section(
        "by_actor",
        "Events by actor",
        "System or deleted account: events recorded without a signed-in user (scheduled jobs, sign-in attempts of unknown accounts) and events of accounts deleted since.",
        columns([
          ["actor", "Actor"],
          ["userId", "User id"],
          ["events", "Events"],
          ["changes", "Changes"],
          ["signIns", "Sign-ins"],
          ["other", "Other"],
          ["areas", "Areas"],
          ["firstAt", "First event (UTC)"],
          ["lastAt", "Last event (UTC)"],
        ]),
        actorRows
      ),
      section(
        "events",
        "Events",
        "Oldest first. Kind: change, sign-in, or other (exports, tests, verifications, reports).",
        columns([
          ["id", "Event"],
          ["at", "Time (UTC)"],
          ["actor", "Actor"],
          ["kind", "Kind"],
          ["area", "Area"],
          ["action", "Action"],
          ["entityType", "Entity"],
          ["entityId", "Entity id"],
          ["summary", "Summary"],
          ["chained", "In hash chain"],
        ]),
        eventRows,
        { limit: MAX_LISTED_EVENTS, total: events.total }
      ),
    ],
    notes: [
      "The hash chain covers each event's time, actor, action, entity, summary and data; changing, inserting or deleting an event breaks it from that event on. Deleting the newest events leaves a valid shorter chain: compare the head hash with a streamed or exported copy, or with an earlier report.",
      "Actors are shown as they are now. Deleting an account removes its name from its events, which then appear under \"System or deleted account\"; the hash chain still verifies them.",
    ],
  };
}
