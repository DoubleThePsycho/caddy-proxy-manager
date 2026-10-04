/**
 * The two requests the usage ping makes to its endpoint: the daily ping
 * (POST) and an erasure request (DELETE) when an administrator turns the
 * ping off or resets the install id. Each is one request with a 10 second
 * time limit, no redirects followed and no credentials; the response body is
 * never read. Neither throws.
 */
import type { UsagePingPayload } from "./payload";
import { USAGE_PING_SCHEMA_VERSION } from "./payload";

export const USAGE_PING_TIMEOUT_MS = 10_000;

export type UsagePingSendResult = { ok: true } | { ok: false; error: string };

async function request(url: string, method: "POST" | "DELETE", body: unknown, fetchImpl: typeof fetch): Promise<UsagePingSendResult> {
  try {
    const response = await fetchImpl(url, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      redirect: "manual",
      credentials: "omit",
      cache: "no-store",
      signal: AbortSignal.timeout(USAGE_PING_TIMEOUT_MS),
    });
    // Nothing in the response is used.
    await response.body?.cancel().catch(() => undefined);
    if (response.status >= 200 && response.status < 300) return { ok: true };
    if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
      return { ok: false, error: "the endpoint answered with a redirect, which is not followed" };
    }
    return { ok: false, error: `the endpoint answered HTTP ${response.status}` };
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      return { ok: false, error: `no answer within ${USAGE_PING_TIMEOUT_MS / 1000} seconds` };
    }
    return { ok: false, error: "the endpoint could not be reached" };
  }
}

/** One POST of the payload. */
export function sendUsagePing(url: string, payload: UsagePingPayload, fetchImpl: typeof fetch = fetch): Promise<UsagePingSendResult> {
  return request(url, "POST", payload, fetchImpl);
}

/** Asks the receiving service to delete everything it stores for `installId`. */
export function sendUsagePingErasure(url: string, installId: string, fetchImpl: typeof fetch = fetch): Promise<UsagePingSendResult> {
  return request(url, "DELETE", { schema: USAGE_PING_SCHEMA_VERSION, install_id: installId }, fetchImpl);
}
