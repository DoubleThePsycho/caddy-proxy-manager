import type { UserActionResult } from "./actions";

/**
 * Runs a user Server Action and returns its error message, or null on
 * success. A rejected call (network failure, lost session) becomes
 * `fallback` so the page shows it instead of crashing.
 */
export async function runUserAction(action: () => Promise<UserActionResult>, fallback: string): Promise<string | null> {
  try {
    const result = await action();
    return result.ok ? null : result.error;
  } catch {
    return fallback;
  }
}
