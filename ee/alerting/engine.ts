// SPDX-License-Identifier: Elastic-2.0
/**
 * Alert evaluation: compares what the evaluators find with the stored
 * per-rule state, records transitions in the history and notifies.
 *
 * - A subject that starts matching fires: one notification, unless a firing
 *   notification for the same rule and subject went out less than the rule's
 *   cooldown ago (the transition is still recorded, as not notified).
 * - A firing subject that no longer matches resolves. Its resolve notice goes
 *   to every channel when the rule asks for it, and always to PagerDuty (to
 *   close the incident), but only if the firing notification was sent.
 * - While a subject keeps firing nothing is sent again.
 * - With a "for" duration (forMinutes), a subject that starts matching is
 *   pending first and fires only once it has matched for that long; one that
 *   stops matching while pending is forgotten without any event.
 * - An evaluator that cannot tell ("skipped") changes nothing; one that can
 *   tell about some subjects only names the others (preserveKeys and
 *   preservePrefixes), which keep their state.
 *
 * Runs regardless of the license: configured alerts keep working.
 */
import { and, eq, isNull, lt, or } from "drizzle-orm";
import { appDb } from "@/src/lib/db";
import { alertEvents, alertRuleStates } from "@/src/lib/db/schema";
import { explainAlert } from "@/ee/ai/explain";
import { ChannelSecretsUnavailableError, getChannelRows, recordChannelDelivery, resolveChannel } from "./channels";
import { deliverToChannel, type DeliveryResult } from "./deliver";
import { evaluateRule, type Evaluation, type Finding } from "./evaluators";
import { pruneAlertEvents } from "./events";
import { cleanText, type AlertNotification } from "./format";
import { listEnabledRules, type StoredRule } from "./rules";
import type { Severity } from "./types";

/** New firing subjects handled per rule and run; the rest wait for the next run. */
export const MAX_NEW_ALERTS_PER_RULE_RUN = 20;

type ChannelRow = Awaited<ReturnType<typeof getChannelRows>>[number];
type StateRow = typeof alertRuleStates.$inferSelect;

export type EngineDependencies = {
  deliver: (channel: Parameters<typeof deliverToChannel>[0], n: AlertNotification) => Promise<DeliveryResult>;
  explain: typeof explainAlert;
  evaluate: typeof evaluateRule;
};

const defaultDependencies: EngineDependencies = {
  deliver: deliverToChannel,
  explain: explainAlert,
  evaluate: evaluateRule,
};

export type EvaluationSummary = {
  rules: number;
  skipped: number;
  fired: number;
  resolved: number;
  notifications: number;
};

type Transition = {
  kind: "firing" | "resolved";
  eventId: number;
  subjectKey: string;
  title: string;
  message: string;
  severity: Severity;
  facts: Record<string, unknown>;
  channels: ChannelRow[];
};

async function insertEvent(values: typeof alertEvents.$inferInsert): Promise<number> {
  const [row] = await appDb.insert(alertEvents).values(values).returning({ id: alertEvents.id });
  return row.id;
}

async function upsertState(values: typeof alertRuleStates.$inferInsert): Promise<void> {
  await appDb
    .insert(alertRuleStates)
    .values(values)
    .onConflictDoUpdate({
      target: [alertRuleStates.ruleId, alertRuleStates.subjectKey],
      set: {
        status: values.status,
        title: values.title,
        firedAt: values.firedAt,
        resolvedAt: values.resolvedAt,
        lastNotifiedAt: values.lastNotifiedAt,
        notifiedFiring: values.notifiedFiring,
        lastEvaluatedAt: values.lastEvaluatedAt,
        pendingSince: values.pendingSince ?? null,
      },
    });
}

type OkEvaluation = Extract<Evaluation, { status: "ok" }>;

function isPreserved(evaluation: Pick<OkEvaluation, "preserveKeys" | "preservePrefixes">, subjectKey: string): boolean {
  if (evaluation.preserveKeys?.includes(subjectKey)) return true;
  return evaluation.preservePrefixes?.some((prefix) => subjectKey.startsWith(prefix)) ?? false;
}

/** Records the transitions of one rule and returns those to notify. */
async function applyTransitions(rule: StoredRule, evaluation: OkEvaluation, channels: ChannelRow[], now: Date): Promise<{
  transitions: Transition[];
  fired: number;
  resolved: number;
}> {
  const at = now.toISOString();
  const findings: Finding[] = evaluation.findings;
  const cooldownMs = rule.cooldownMinutes * 60_000;
  const forMs = (rule.forMinutes ?? 0) * 60_000;
  const states = await appDb.select().from(alertRuleStates).where(eq(alertRuleStates.ruleId, rule.id));
  const byKey = new Map<string, StateRow>(states.map((state) => [state.subjectKey, state]));
  const resolveChannels = rule.notifyOnResolve ? channels : channels.filter((channel) => channel.type === "pagerduty");
  const transitions: Transition[] = [];
  const seen = new Set<string>();
  let fired = 0;
  let resolved = 0;

  for (const finding of findings) {
    if (seen.has(finding.subjectKey)) continue;
    seen.add(finding.subjectKey);
    const state = byKey.get(finding.subjectKey);
    if (state?.status === "firing") {
      await appDb
        .update(alertRuleStates)
        .set({ lastEvaluatedAt: at })
        .where(eq(alertRuleStates.id, state.id));
      continue;
    }
    if (forMs > 0) {
      const since = state?.status === "pending" && state.pendingSince ? Date.parse(state.pendingSince) : NaN;
      if (!Number.isFinite(since)) {
        // The condition starts holding: wait out the rule's "for" duration.
        await upsertState({
          ruleId: rule.id,
          subjectKey: finding.subjectKey,
          status: "pending",
          title: cleanText(finding.label, 300),
          firedAt: null,
          resolvedAt: state?.resolvedAt ?? null,
          lastNotifiedAt: state?.lastNotifiedAt ?? null,
          notifiedFiring: false,
          lastEvaluatedAt: at,
          pendingSince: at,
        });
        continue;
      }
      if (now.getTime() - since < forMs) {
        await appDb.update(alertRuleStates).set({ lastEvaluatedAt: at }).where(eq(alertRuleStates.id, state!.id));
        continue;
      }
    }
    if (fired >= MAX_NEW_ALERTS_PER_RULE_RUN) continue;
    fired += 1;
    const lastNotified = state?.lastNotifiedAt ? Date.parse(state.lastNotifiedAt) : NaN;
    const inCooldown = Number.isFinite(lastNotified) && now.getTime() - lastNotified < cooldownMs;
    const notify = !inCooldown && channels.length > 0;
    const title = cleanText(finding.title, 300);
    const message = cleanText(finding.message, 4000, true);
    const eventId = await insertEvent({
      ruleId: rule.id,
      ruleName: rule.name,
      ruleType: rule.type,
      subjectKey: finding.subjectKey,
      status: "firing",
      severity: finding.severity,
      title,
      message,
      facts: JSON.stringify(finding.facts),
      notified: notify,
      createdAt: at,
    });
    await upsertState({
      ruleId: rule.id,
      subjectKey: finding.subjectKey,
      status: "firing",
      title: cleanText(finding.label, 300),
      firedAt: at,
      resolvedAt: null,
      lastNotifiedAt: notify ? at : state?.lastNotifiedAt ?? null,
      notifiedFiring: notify,
      lastEvaluatedAt: at,
      pendingSince: null,
    });
    if (notify) {
      transitions.push({ kind: "firing", eventId, subjectKey: finding.subjectKey, title, message, severity: finding.severity, facts: finding.facts, channels });
    }
  }

  for (const state of states) {
    if (seen.has(state.subjectKey) || isPreserved(evaluation, state.subjectKey)) continue;
    if (state.status === "pending") {
      // Stopped matching before its "for" duration ran out: nothing happened.
      await appDb
        .update(alertRuleStates)
        .set({ status: "ok", pendingSince: null, lastEvaluatedAt: at })
        .where(eq(alertRuleStates.id, state.id));
      continue;
    }
    if (state.status !== "firing") continue;
    resolved += 1;
    const label = state.title ?? state.subjectKey;
    const notify = state.notifiedFiring && resolveChannels.length > 0;
    const title = cleanText(`Resolved: ${label}`, 300);
    const message = `${label}: no longer reported by rule "${rule.name}".`;
    const eventId = await insertEvent({
      ruleId: rule.id,
      ruleName: rule.name,
      ruleType: rule.type,
      subjectKey: state.subjectKey,
      status: "resolved",
      severity: "info",
      title,
      message,
      facts: null,
      notified: notify,
      createdAt: at,
    });
    await appDb
      .update(alertRuleStates)
      .set({ status: "ok", resolvedAt: at, notifiedFiring: false, lastEvaluatedAt: at, pendingSince: null })
      .where(eq(alertRuleStates.id, state.id));
    if (notify) {
      transitions.push({ kind: "resolved", eventId, subjectKey: state.subjectKey, title, message, severity: "info", facts: {}, channels: resolveChannels });
    }
  }

  // Resolved subjects only matter while their cooldown runs.
  await appDb
    .delete(alertRuleStates)
    .where(
      and(
        eq(alertRuleStates.ruleId, rule.id),
        eq(alertRuleStates.status, "ok"),
        or(isNull(alertRuleStates.lastNotifiedAt), lt(alertRuleStates.lastNotifiedAt, new Date(now.getTime() - cooldownMs).toISOString()))
      )
    );

  return { transitions, fired, resolved };
}

async function notify(rule: StoredRule, transition: Transition, at: string, deps: EngineDependencies): Promise<number> {
  const notification: AlertNotification = {
    kind: transition.kind,
    ruleId: rule.id,
    ruleName: rule.name,
    ruleType: rule.type,
    subjectKey: transition.subjectKey,
    severity: transition.severity,
    title: transition.title,
    message: transition.message,
    facts: transition.facts,
    explanation: null,
    eventId: transition.eventId,
    at,
  };
  if (transition.kind === "firing" && rule.explain) {
    // Bounded by the AI timeout; any failure leaves the explanation out.
    notification.explanation = await deps
      .explain({ ruleType: rule.type, status: "firing", severity: transition.severity, facts: transition.facts })
      .catch(() => null);
  }

  const deliveries = await Promise.all(
    transition.channels.map(async (row) => {
      let result: DeliveryResult;
      try {
        result = await deps.deliver(resolveChannel(row), notification);
      } catch (error) {
        result = {
          ok: false,
          error: error instanceof ChannelSecretsUnavailableError ? error.message : "The notification could not be sent",
        };
      }
      await recordChannelDelivery(row.id, result.error, at).catch(() => undefined);
      return { channelId: row.id, channelName: row.name, ok: result.ok, error: result.error };
    })
  );

  await appDb
    .update(alertEvents)
    .set({ deliveries: JSON.stringify(deliveries), explanation: notification.explanation })
    .where(eq(alertEvents.id, transition.eventId));
  return deliveries.filter((delivery) => delivery.ok).length;
}

/** One evaluation pass over every enabled rule. */
export async function runAlertEvaluation(
  options: { now?: Date } & Partial<EngineDependencies> = {}
): Promise<EvaluationSummary> {
  const now = options.now ?? new Date();
  const deps: EngineDependencies = {
    deliver: options.deliver ?? defaultDependencies.deliver,
    explain: options.explain ?? defaultDependencies.explain,
    evaluate: options.evaluate ?? defaultDependencies.evaluate,
  };
  const at = now.toISOString();
  const summary: EvaluationSummary = { rules: 0, skipped: 0, fired: 0, resolved: 0, notifications: 0 };
  const pending: Promise<number>[] = [];

  for (const rule of await listEnabledRules()) {
    summary.rules += 1;
    let evaluation;
    try {
      evaluation = await deps.evaluate(rule, now);
    } catch (error) {
      console.warn(`[alerting] Rule ${rule.id} could not be evaluated:`, error instanceof Error ? error.name : typeof error);
      summary.skipped += 1;
      continue;
    }
    if (evaluation.status === "skipped") {
      summary.skipped += 1;
      continue;
    }
    const channels = (await getChannelRows(rule.channelIds)).filter((channel) => channel.enabled);
    const { transitions, fired, resolved } = await applyTransitions(rule, evaluation, channels, now);
    summary.fired += fired;
    summary.resolved += resolved;
    // Rules notify concurrently so a slow channel or model never holds up another alert.
    for (const transition of transitions) pending.push(notify(rule, transition, at, deps).catch(() => 0));
  }

  for (const sent of await Promise.all(pending)) summary.notifications += sent;
  await pruneAlertEvents(now).catch(() => undefined);
  return summary;
}
