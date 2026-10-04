import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { syncInstances } from "@/src/lib/instance-sync";

export async function POST(request: NextRequest) {
  try {
    await requireApiPermission(request, "instances:write");
    const result = await syncInstances();
    return NextResponse.json(result);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
