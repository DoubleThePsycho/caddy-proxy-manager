import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { previewProxyHostChange } from "@/src/lib/proxy-host-changes";

/**
 * What POST /api/v1/proxy-hosts with this body would do, without creating
 * anything: whether a change approval policy covers it, the fields it sets
 * and its impact.
 */
export async function POST(request: NextRequest) {
  try {
    const { access } = await requireApiPermission(request, "proxy_hosts:write");
    const body = await request.json().catch(() => null);
    return NextResponse.json(await previewProxyHostChange(access, null, { host: body }));
  } catch (error) {
    return apiErrorResponse(error);
  }
}
