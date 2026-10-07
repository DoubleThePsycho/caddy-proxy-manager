// SPDX-License-Identifier: Elastic-2.0
/**
 * The one request automatic license updates make: GET the current key of a
 * license from the license server, with the license's refresh token as a
 * bearer token. One request with a 10 second time limit, no redirects
 * followed, no cookies, and a response body read up to 16 KiB. Never throws;
 * errors are short, written here, and never contain the token or a response
 * body.
 */

export const LICENSE_SERVER_TIMEOUT_MS = 10_000;
export const MAX_LICENSE_RESPONSE_BYTES = 16 * 1024;

export type CurrentLicenseResult =
  | { kind: "ok"; key: string }
  | { kind: "unauthorized" }
  | { kind: "revoked" }
  | { kind: "error"; error: string };

/** Raised by readLimitedBody for an answer over MAX_LICENSE_RESPONSE_BYTES. */
export class TooLarge extends Error {}

/** The body as text, up to MAX_LICENSE_RESPONSE_BYTES (a missing or false Content-Length does not get around it). */
export async function readLimitedBody(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_LICENSE_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new TooLarge();
  }
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_LICENSE_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new TooLarge();
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

export async function discardBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

export async function fetchCurrentLicenseKey(
  url: string,
  refreshToken: string,
  fetchImpl: typeof fetch = fetch
): Promise<CurrentLicenseResult> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: { authorization: `Bearer ${refreshToken}`, accept: "application/json" },
      redirect: "manual",
      credentials: "omit",
      cache: "no-store",
      signal: AbortSignal.timeout(LICENSE_SERVER_TIMEOUT_MS),
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      return { kind: "error", error: `no answer within ${LICENSE_SERVER_TIMEOUT_MS / 1000} seconds` };
    }
    return { kind: "error", error: "the license server could not be reached" };
  }

  if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
    await discardBody(response);
    return { kind: "error", error: "the license server answered with a redirect, which is not followed" };
  }
  if (response.status === 401 || response.status === 403) {
    await discardBody(response);
    return { kind: "unauthorized" };
  }
  if (response.status === 410) {
    await discardBody(response);
    return { kind: "revoked" };
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
    const name = error instanceof Error ? error.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      return { kind: "error", error: `no answer within ${LICENSE_SERVER_TIMEOUT_MS / 1000} seconds` };
    }
    return { kind: "error", error: "the license server's answer could not be read" };
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { kind: "error", error: "the license server's answer is not JSON" };
  }
  const key = typeof body === "object" && body !== null && !Array.isArray(body) ? (body as { key?: unknown }).key : undefined;
  if (typeof key !== "string" || key.trim().length === 0 || key.length > MAX_LICENSE_RESPONSE_BYTES) {
    return { kind: "error", error: "the license server's answer has no license key" };
  }
  return { kind: "ok", key: key.trim() };
}
