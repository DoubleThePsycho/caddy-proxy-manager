import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { listGroups, createGroup } from "@/src/lib/models/groups";

export async function GET(request: NextRequest) {
  try {
    await requireApiPermission(request, "groups:read");
    const allGroups = await listGroups();
    return NextResponse.json(allGroups);
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const { userId } = await requireApiPermission(request, "groups:write");
    const body = await request.json();
    const group = await createGroup(body, userId);
    return NextResponse.json(group, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
