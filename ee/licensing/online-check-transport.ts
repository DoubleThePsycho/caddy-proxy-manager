// SPDX-License-Identifier: Elastic-2.0
/**
 * The requests of the online license check, to the license server's
 * endpoints for one license id:
 *
 * - POST …/status with {"keySha256", "installId"}: the SHA-256 of the
 *   installed key and this install's license install id. The answer is a
 *   status statement.
 * - POST …/deactivate with the same body: releases the license on this
 *   install, so another install can take it.
 *
 * Nothing else is sent. One request with a 10 second time limit, no
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

export type LicenseDeactivateResult = { kind: "ok" } | { kind: "unknown" } | { kind: "error"; error: string };

const TIMED_OUT = `no answer within ${LICENSE_SERVER_TIMEOUT_MS / 1000} seconds`;

function isTimeout(error: unknown): boolean {
  const name = error instanceof Error ? error.name : "";
  return name === "TimeoutError" || name === "AbortError";
}

type Sent = { kind: "response"; response: Response } | { kind: "unknown" } | { kind: "error"; error: string };

/** One POST of `body`; the 200 response is left unread, every other answer is mapped here. */
async function post(url: string, body: Record<string, string>, fetchImpl: typeof fetch): Promise<Sent> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
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
  return { kind: "response", response };
}

/** Reads a 200 answer as a JSON object. */
async function readJsonObject(response: Response): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; error: string }> {
  let text: string;
  try {
    text = await readLimitedBody(response);
  } catch (error) {
    if (error instanceof TooLarge) return { ok: false, error: "the license server's answer is too large" };
    return { ok: false, error: isTimeout(error) ? TIMED_OUT : "the license server's answer could not be read" };
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { ok: false, error: "the license server's answer is not JSON" };
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, error: "the license server's answer is not JSON" };
  }
  return { ok: true, body: body as Record<string, unknown> };
}

export async function postLicenseStatus(
  url: string,
  keySha256: string,
  installId: string,
  fetchImpl: typeof fetch = fetch
): Promise<LicenseStatusResult> {
  const sent = await post(url, { keySha256, installId }, fetchImpl);
  if (sent.kind !== "response") return sent;
  const read = await readJsonObject(sent.response);
  if (!read.ok) return { kind: "error", error: read.error };
  const statement = read.body.statement;
  if (typeof statement !== "string" || statement.trim().length === 0 || statement.length > MAX_LICENSE_RESPONSE_BYTES) {
    return { kind: "error", error: "the license server's answer has no status statement" };
  }
  return { kind: "ok", statement: statement.trim() };
}

export async function postLicenseDeactivate(
  url: string,
  keySha256: string,
  installId: string,
  fetchImpl: typeof fetch = fetch
): Promise<LicenseDeactivateResult> {
  const sent = await post(url, { keySha256, installId }, fetchImpl);
  if (sent.kind !== "response") return sent;
  const read = await readJsonObject(sent.response);
  if (!read.ok) return { kind: "error", error: read.error };
  if (read.body.deactivated !== true) return { kind: "error", error: "the license server did not confirm the deactivation" };
  return { kind: "ok" };
}
