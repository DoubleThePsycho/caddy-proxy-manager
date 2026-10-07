import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { readJsonBody } from "@/src/lib/access-list-http";
import { listAccessLists, createAccessList, type AccessListInput } from "@/src/lib/models/access-lists";

export async function GET(request: NextRequest) {
  try {
    await requireApiPermission(request, "access_lists:read");
    const lists = await listAccessLists();
    return NextResponse.json(lists);
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const { userId } = await requireApiPermission(request, "access_lists:write");
    const body = await readJsonBody(request);
    // The model validates every field.
    const list = await createAccessList(body as AccessListInput, userId);
    return NextResponse.json(list, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
