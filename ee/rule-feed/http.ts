// SPDX-License-Identifier: Elastic-2.0
/**
 * HTTP helpers of the virtual patching endpoints.
 */
import { NextResponse, type NextRequest } from "next/server";
import { apiErrorResponse } from "@/src/lib/api-auth";
import { ApiValidationError } from "@/src/lib/api-errors";
import { RuleFeedFetchError, VirtualPatchApplyError } from "./service";
import { RULE_FEED_LIMITS, type VirtualPatchingView } from "./types";

export const NO_STORE = { "Cache-Control": "no-store" };

/** apiErrorResponse, plus 502 when the feed URL failed or Caddy refused the patches (nothing changed). */
export function ruleFeedErrorResponse(error: unknown): NextResponse {
  if (error instanceof RuleFeedFetchError || error instanceof VirtualPatchApplyError) {
    return NextResponse.json({ error: error.message }, { status: 502 });
  }
  return apiErrorResponse(error);
}

/** The JSON object body of a request. */
export async function readJsonBody(request: NextRequest): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new ApiValidationError("Request body must be JSON");
  }
}

/** The raw body (a feed document), read no further than the feed size limit. */
export async function readFeedBody(request: NextRequest): Promise<string> {
  const limit = RULE_FEED_LIMITS.feedBytes;
  const tooLarge = () => new ApiValidationError(`The feed is larger than ${limit / (1024 * 1024)} MiB`);
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > limit) throw tooLarge();
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** The feed part of the view: GET /api/v1/waf/rule-feed. */
export function ruleFeedStatus(view: VirtualPatchingView) {
  return {
    settings: view.settings,
    feed: view.feed,
    counts: view.counts,
    available: view.available,
    configurable: view.configurable,
    editable: view.editable,
    source: view.source,
  };
}
