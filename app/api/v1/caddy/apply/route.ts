import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { applyCaddyConfig } from "@/src/lib/caddy";

export async function POST(request: NextRequest) {
  try {
    await requireApiPermission(request, "settings:write");
    await applyCaddyConfig();
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
