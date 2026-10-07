// SPDX-License-Identifier: Elastic-2.0
/**
 * The one request of the online license check: POST the SHA-256 of the
 * installed key to the license server's status endpoint for its license
 * id. Nothing else is sent. One request with a 10 second time limit, no
 * redirects followed, no cookies, and a response body read up to 16 KiB.
 * Never throws; errors are short, written here, and never contain a
 * response body.
 */
import { discardBody, LICENSE_SERVER_TIMEOUT_MS, MAX_LICENSE_RESPONSE_BYTES, readLimitedBody, TooLarge } from "./auto-update-transport";

export type LicenseStatusResult =
  | { kind: "ok"; statement: string }
  /** 404: the server knows no such license, or no such key for it. */
  | { kind: "unknown" }
  | { kind: "error"; error: string };

const TIMED_OUT = `no answer within ${LICENSE_SERVER_TIMEOUT_MS / 1000} seconds`;

function isTimeout(error: unknown): boolean {
  const name = error instanceof Error ? error.name : "";
  return name === "TimeoutError" || name === "AbortError";
}

export async function postLicenseStatus(url: string, keySha256: string, fetchImpl: typeof fetch = fetch): Promise<LicenseStatusResult> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ keySha256 }),
      redirect: "manual",
      credentials: "omit",
      cache: "no-store",
      signal: AbortSignal.timeout(LICENSE_SERVER_TIMEOUT_MS),
    });
  } catch (error) {
    return { kind: "error", error: isTimeout(error) ? TIMED_OUT : "the license server could not be reached" };
  }

  if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
    await discardBody(response);
    return { kind: "error", error: "the license server answered with a redirect, which is not followed" };
  }
  if (response.status === 404) {
    await discardBody(response);
    return { kind: "unknown" };
  }
  if (response.status === 429) {
    await discardBody(response);
    return { kind: "error", error: "the license server is limiting requests (HTTP 429)" };
  }
  if (response.status !== 200) {
    await discardBody(response);
    return { kind: "error", error: `the license server answered HTTP ${response.status}` };
  }

  let text: string;
  try {
    text = await readLimitedBody(response);
  } catch (error) {
    if (error instanceof TooLarge) return { kind: "error", error: "the license server's answer is too large" };
    return { kind: "error", error: isTimeout(error) ? TIMED_OUT : "the license server's answer could not be read" };
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { kind: "error", error: "the license server's answer is not JSON" };
  }
  const statement =
    typeof body === "object" && body !== null && !Array.isArray(body) ? (body as { statement?: unknown }).statement : undefined;
  if (typeof statement !== "string" || statement.trim().length === 0 || statement.length > MAX_LICENSE_RESPONSE_BYTES) {
    return { kind: "error", error: "the license server's answer has no status statement" };
  }
  return { kind: "ok", statement: statement.trim() };
}
