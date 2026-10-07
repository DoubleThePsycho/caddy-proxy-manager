// SPDX-License-Identifier: Elastic-2.0
/**
 * Administrator tools for a directory: test the connection, and test a
 * sign-in without signing anyone in. Both work on a disabled directory, so
 * one can be checked before it is turned on. Both are recorded in the audit log.
 *
 * A test sign-in tells the administrator why it failed (unknown user, wrong
 * password, several entries, ...), which sign-in itself never does. It uses
 * the same rate limits as sign-in for the username, so it is no way around
 * them.
 */
import { appDb } from "@/src/lib/db";
import { logAuditEvent } from "@/src/lib/audit";
import { ApiClientError, ApiValidationError } from "@/src/lib/api-errors";
import { authenticateDirectoryUser, testDirectoryConnection, type AuthFailureReason, type ConnectionTestResult } from "./authenticate";
import { describeDirectoryError } from "./connection";
import { describeFailedCheck, recordDirectoryHealth } from "./health";
import { LIMITS } from "./constants";
import { requireDirectoryRow } from "./directories";
import { beginDirectoryAttempt, signInAccountKey } from "./limiter";
import { resolveDirectoryRole, type RoleDecision } from "./roles";
import { planLocalAccount, REFUSAL_DESCRIPTIONS } from "./sign-in";
import { toDirectoryConfig } from "./store";
import type { DirectoryUser } from "./types";

export async function testDirectory(id: number, actorUserId: number): Promise<ConnectionTestResult> {
  const row = await requireDirectoryRow(id);
  let result: ConnectionTestResult;
  try {
    result = await testDirectoryConnection(toDirectoryConfig(row));
  } catch (error) {
    result = { ok: false, steps: [{ step: "connect", ok: false, detail: describeDirectoryError(error) }] };
  }
  // An enabled directory's health follows the test, so fixing a directory
  // and testing it clears the overview's warning at once.
  if (row.enabled) {
    await recordDirectoryHealth({ id: row.id, name: row.name }, result.ok ? { ok: true } : { ok: false, error: describeFailedCheck(result) });
  }
  await logAuditEvent({
    userId: actorUserId,
    action: "ldap_directory_tested",
    entityType: "ldap_directory",
    entityId: id,
    summary: `Tested the connection to LDAP directory "${row.name}": ${result.ok ? "succeeded" : "failed"}`,
    data: { ok: result.ok, steps: result.steps },
  });
  return result;
}

export type LocalAccountPreview = {
  /** existing: signs in to the linked account; link: links the account with the same e-mail; provision: creates one; refuse. */
  action: "existing" | "link" | "provision" | "refuse";
  userId: number | null;
  /** Why it would be refused, when it would. */
  reason: string | null;
};

export type SignInTestResult = {
  ok: boolean;
  /** "success" or why the directory refused: invalid_input, directory_unavailable, unknown_user, multiple_entries, wrong_password, incomplete_entry, groups_unavailable. */
  outcome: "success" | AuthFailureReason;
  detail: string;
  /** The entry as sign-in reads it; null unless the password was accepted. */
  user: DirectoryUser | null;
  /** What the group mapping gives; null unless the password was accepted. */
  roles: RoleDecision | null;
  /** What a real sign-in would do with the local account; null unless the password was accepted. */
  account: LocalAccountPreview | null;
};

function parseTestBody(body: unknown): { username: string; password: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ApiValidationError("Request body must be a JSON object");
  }
  const record = body as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "username" && key !== "password") throw new ApiValidationError(`Unknown field "${key}"`);
  }
  if (typeof record.username !== "string" || typeof record.password !== "string") {
    throw new ApiValidationError("username and password are required");
  }
  if (record.username.length > LIMITS.username || record.password.length > LIMITS.password) {
    throw new ApiValidationError("username or password is too long");
  }
  return { username: record.username, password: record.password };
}

export async function testDirectorySignIn(id: number, body: unknown, actorUserId: number, ip: string): Promise<SignInTestResult> {
  const row = await requireDirectoryRow(id);
  const { username, password } = parseTestBody(body);
  const attempt = await beginDirectoryAttempt(signInAccountKey(id, username), ip);
  if (!attempt) throw new ApiClientError("Too many sign-in attempts for this username. Try again in a few minutes.", 429);

  let result: SignInTestResult;
  try {
    const config = toDirectoryConfig(row);
    const outcome = await authenticateDirectoryUser(config, username, password);
    if (!outcome.ok) {
      if (outcome.reason === "directory_unavailable") await attempt.release();
      else await attempt.fail();
      result = { ok: false, outcome: outcome.reason, detail: outcome.detail, user: null, roles: null, account: null };
    } else {
      await attempt.succeed();
      const roles = resolveDirectoryRole(config, outcome.user.groups);
      const plan = await planLocalAccount(appDb, config, outcome.user);
      const account: LocalAccountPreview = plan.action === "refuse"
        ? { action: "refuse", userId: plan.userId ?? null, reason: REFUSAL_DESCRIPTIONS[plan.reason] }
        : { action: plan.action, userId: plan.action === "provision" ? null : plan.userId, reason: null };
      if (!roles.inRequiredGroup) {
        account.action = "refuse";
        account.reason = REFUSAL_DESCRIPTIONS.not_in_required_group;
      }
      result = { ok: true, outcome: "success", detail: "the directory accepted the password", user: outcome.user, roles, account };
    }
  } catch (error) {
    await attempt.release();
    result = { ok: false, outcome: "directory_unavailable", detail: describeDirectoryError(error), user: null, roles: null, account: null };
  } finally {
    await attempt.release();
  }

  await logAuditEvent({
    userId: actorUserId,
    action: "ldap_directory_sign_in_tested",
    entityType: "ldap_directory",
    entityId: id,
    summary: `Tested a sign-in to LDAP directory "${row.name}" as ${username.trim().slice(0, 100)}: ${result.outcome}`,
    data: { username: username.trim().slice(0, LIMITS.username), outcome: result.outcome, dn: result.user?.dn ?? null },
  });
  return result;
}
