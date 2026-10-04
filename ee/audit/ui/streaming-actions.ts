// SPDX-License-Identifier: Elastic-2.0
"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/src/lib/auth";
import { ApiClientError } from "@/src/lib/api-errors";
import { createAuditSink, deleteAuditSink, testAuditSink, updateAuditSink } from "@/ee/audit/sinks";
import { setAuditRetention } from "@/ee/audit/retention";
import type { AuditSinkTestResult } from "@/ee/audit/types";

type ActionResult = { ok: true } | { error: string };

const PATH = "/audit-log/streaming";

/** Runs an ee/audit action as the signed-in administrator; client errors come back as messages. */
async function run<T>(action: (userId: number) => Promise<T>): Promise<{ value: T } | { error: string }> {
  const session = await requirePermission("audit_streaming:write");
  try {
    return { value: await action(Number(session.user.id)) };
  } catch (error) {
    if (error instanceof ApiClientError) return { error: error.message };
    throw error;
  }
}

function done(outcome: { error: string } | { value: unknown }): ActionResult {
  if ("error" in outcome) return outcome;
  revalidatePath(PATH);
  return { ok: true };
}

export async function createAuditSinkAction(input: unknown): Promise<ActionResult> {
  return done(await run((userId) => createAuditSink(input, userId)));
}

export async function updateAuditSinkAction(id: number, input: unknown): Promise<ActionResult> {
  return done(await run((userId) => updateAuditSink(id, input, userId)));
}

export async function deleteAuditSinkAction(id: number): Promise<ActionResult> {
  return done(await run((userId) => deleteAuditSink(id, userId)));
}

export async function testAuditSinkAction(id: number): Promise<{ result: AuditSinkTestResult } | { error: string }> {
  const outcome = await run((userId) => testAuditSink(id, userId));
  return "error" in outcome ? outcome : { result: outcome.value };
}

export async function saveAuditRetentionAction(days: number): Promise<ActionResult> {
  return done(await run((userId) => setAuditRetention({ days }, userId)));
}
