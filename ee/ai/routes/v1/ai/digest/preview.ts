// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { previewDigest } from "@/ee/ai/digest";
import { NO_STORE } from "@/ee/alerting/http";
import { ApiValidationError } from "@/src/lib/api-errors";

/** The optional body is {"ai": boolean}; an empty body uses the saved setting. */
async function readOptionalBody(request: NextRequest): Promise<unknown> {
  const text = await request.text();
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiValidationError("Request body must be JSON");
  }
}

export async function POST(request: NextRequest) {
  try {
    const { userId } = await requireApiPermission(request, "ai:write");
    return NextResponse.json(await previewDigest(await readOptionalBody(request), userId), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
