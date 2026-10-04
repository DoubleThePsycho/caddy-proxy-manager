import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { listInstances, createInstance } from "@/src/lib/models/instances";
import { instanceSyncTokenValidationError } from "@/src/lib/instance-sync-token";

export async function GET(request: NextRequest) {
  try {
    await requireApiPermission(request, "instances:read");
    const instances = await listInstances();
    return NextResponse.json(instances);
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    await requireApiPermission(request, "instances:write");
    const body = await request.json();
    const tokenError = instanceSyncTokenValidationError(body?.apiToken);
    if (tokenError) {
      return NextResponse.json({ error: tokenError }, { status: 400 });
    }
    const instance = await createInstance(body);
    return NextResponse.json(instance, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
