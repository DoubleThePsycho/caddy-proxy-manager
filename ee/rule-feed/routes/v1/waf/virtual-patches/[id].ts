// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission } from "@/src/lib/api-auth";
import { NO_STORE, readJsonBody, ruleFeedErrorResponse } from "@/ee/rule-feed/http";
import { getVirtualPatch, setVirtualPatchMode } from "@/ee/rule-feed/service";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: Context) {
  try {
    await requireApiPermission(request, "virtual_patches:read");
    return NextResponse.json(await getVirtualPatch((await params).id), { headers: NO_STORE });
  } catch (error) {
    return ruleFeedErrorResponse(error);
  }
}

/** Sets the mode: off, detect or block. Turning a patch on needs the license; turning it off never does. */
export async function PUT(request: NextRequest, { params }: Context) {
  try {
    const { userId } = await requireApiPermission(request, "virtual_patches:write");
    const id = (await params).id;
    return NextResponse.json(await setVirtualPatchMode(id, await readJsonBody(request), userId), { headers: NO_STORE });
  } catch (error) {
    return ruleFeedErrorResponse(error);
  }
}
