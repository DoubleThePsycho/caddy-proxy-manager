/**
 * Free-form tags on proxy hosts and L4 proxy hosts (Community). Tags alone
 * change nothing: they label hosts in the lists, and a custom role
 * (ee/custom-roles) can be limited to hosts that carry one of its tags.
 *
 * A tag is stored lowercased; it starts with a letter or digit and may contain
 * letters, digits and . _ : / - (no spaces), up to MAX_TAG_LENGTH characters.
 */
import { ApiValidationError } from "./api-errors";

export const MAX_TAG_LENGTH = 40;
export const MAX_TAGS_PER_HOST = 16;

const TAG_PATTERN = /^[a-z0-9][a-z0-9._:/-]*$/;

export const TAG_RULES_MESSAGE =
  `Tags start with a letter or digit and contain only letters, digits and . _ : / - (no spaces), ` +
  `at most ${MAX_TAG_LENGTH} characters`;

export function isValidTag(value: string): boolean {
  return value.length > 0 && value.length <= MAX_TAG_LENGTH && TAG_PATTERN.test(value);
}

/**
 * Validates a tag list from a request (an array of strings, or a comma
 * separated string from a form) and returns it trimmed, lowercased,
 * deduplicated and sorted. Throws ApiValidationError for anything else.
 */
export function normalizeTags(input: unknown): string[] {
  if (input === null || input === undefined) return [];
  let values: unknown[];
  if (typeof input === "string") {
    values = input.split(",");
  } else if (Array.isArray(input)) {
    values = input;
  } else {
    throw new ApiValidationError("tags must be an array of strings");
  }
  const tags = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string") {
      throw new ApiValidationError("tags must be an array of strings");
    }
    const tag = value.trim().toLowerCase();
    if (!tag) continue;
    if (!isValidTag(tag)) {
      throw new ApiValidationError(`Invalid tag "${tag.slice(0, MAX_TAG_LENGTH)}". ${TAG_RULES_MESSAGE}`);
    }
    tags.add(tag);
  }
  if (tags.size > MAX_TAGS_PER_HOST) {
    throw new ApiValidationError(`A host can have at most ${MAX_TAGS_PER_HOST} tags`);
  }
  return [...tags].sort();
}

/** The tags column as stored (a JSON array); anything unreadable counts as no tags. */
export function parseStoredTags(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.filter((tag): tag is string => typeof tag === "string" && isValidTag(tag));
  } catch {
    return [];
  }
}

export function serializeTags(tags: readonly string[]): string {
  return JSON.stringify([...tags]);
}
