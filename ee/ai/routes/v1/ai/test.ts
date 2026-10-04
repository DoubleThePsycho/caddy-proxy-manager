// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { testAiProvider } from "@/ee/ai/explain";

export async function POST(request: NextRequest) {
  try {
    const { userId } = await requireApiPermission(request, "ai:write");
    return NextResponse.json(await testAiProvider(userId));
  } catch (error) {
    return apiErrorResponse(error);
  }
}
