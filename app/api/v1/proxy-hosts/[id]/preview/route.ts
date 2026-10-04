import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { previewProxyHostChange } from "@/src/lib/proxy-host-changes";
import { parseRowId } from "@/src/lib/row-ids";

type Params = { params: Promise<{ id: string }> };

/**
 * What PUT /api/v1/proxy-hosts/{id} with this body would do, without
 * changing anything: whether a change approval policy covers it, the fields
 * it changes and its impact.
 */
export async function POST(request: NextRequest, { params }: Params) {
  try {
    const { access } = await requireApiPermission(request, "proxy_hosts:write");
    const { id } = await params;
    const hostId = parseRowId(id);
    if (hostId === null) throw new Error("Proxy host not found");
    const body = await request.json().catch(() => null);
    return NextResponse.json(await previewProxyHostChange(access, hostId, { host: body }));
  } catch (error) {
    return apiErrorResponse(error);
  }
}
