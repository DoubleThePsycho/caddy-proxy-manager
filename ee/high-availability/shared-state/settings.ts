// SPDX-License-Identifier: Elastic-2.0
/**
 * The shared state switch: validation of REST and dashboard input and
 * parsing of the stored value. No database access.
 */
import { randomBytes } from "node:crypto";
import { ApiValidationError } from "@/src/lib/api-errors";
import { isPlainObject, rejectUnknownKeys, requireObject } from "@/ee/alerting/validation";
import { DEFAULT_SHARED_STATE_PREFIX, SHARED_STATE_LIMITS, type StoredSharedState } from "./types";

const KEY_PREFIX = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const GENERATION = /^[a-f0-9]{8,32}$/;

export function newGeneration(): string {
  return randomBytes(6).toString("hex");
}

function readKeyPrefix(value: unknown): string {
  if (value === undefined || value === null || value === "") return DEFAULT_SHARED_STATE_PREFIX;
  if (typeof value !== "string") throw new ApiValidationError("keyPrefix must be a string");
  const prefix = value.trim();
  if (prefix.length > SHARED_STATE_LIMITS.keyPrefix) {
    throw new ApiValidationError(`keyPrefix must be at most ${SHARED_STATE_LIMITS.keyPrefix} characters`);
  }
  if (!KEY_PREFIX.test(prefix)) {
    throw new ApiValidationError('keyPrefix may contain letters, digits, ".", "_" and "-", and must start with a letter or digit');
  }
  return prefix;
}

/**
 * The setting an API body ({enabled?, keyPrefix?}) describes, given the stored
 * one. A missing field keeps the stored value. Turning shared state on, or
 * changing the prefix while it is on, starts a new generation: nothing kept
 * under an earlier one is read again.
 */
export function parseSharedStateInput(body: unknown, previous: StoredSharedState | null): StoredSharedState {
  const record = requireObject(body, "Request body");
  rejectUnknownKeys(record, ["enabled", "keyPrefix"], "the shared state settings");
  const enabled = record.enabled === undefined ? previous?.enabled ?? true : record.enabled;
  if (typeof enabled !== "boolean") throw new ApiValidationError("enabled must be true or false");
  const keyPrefix = record.keyPrefix === undefined ? previous?.keyPrefix ?? DEFAULT_SHARED_STATE_PREFIX : readKeyPrefix(record.keyPrefix);
  const restart = enabled && (!previous?.enabled || previous.keyPrefix !== keyPrefix);
  return { enabled, keyPrefix, generation: restart || !previous ? newGeneration() : previous.generation };
}

/** A stored value as the setting; null when unset or not valid (shared state is then off). */
export function parseStoredSharedState(value: unknown): StoredSharedState | null {
  if (!isPlainObject(value)) return null;
  if (typeof value.enabled !== "boolean") return null;
  if (typeof value.keyPrefix !== "string" || value.keyPrefix.length > SHARED_STATE_LIMITS.keyPrefix || !KEY_PREFIX.test(value.keyPrefix)) {
    return null;
  }
  if (typeof value.generation !== "string" || !GENERATION.test(value.generation)) return null;
  return { enabled: value.enabled, keyPrefix: value.keyPrefix, generation: value.generation };
}

/** `<keyPrefix>:<generation>:`, the start of every key. */
export function sharedStateNamespace(setting: Pick<StoredSharedState, "keyPrefix" | "generation">): string {
  return `${setting.keyPrefix}:${setting.generation}:`;
}
