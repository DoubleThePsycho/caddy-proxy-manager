import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { findProxyHostInScope } from "@/src/lib/access-scope";
import { getProxyHostHealth } from "@/src/lib/upstream-health";
import { parseRowId } from "@/src/lib/row-ids";

/**
 * The health of a proxy host's upstreams as Caddy sees it now (its admin
 * API's upstream pool), with the host's health check settings.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { access } = await requireApiPermission(request, "proxy_hosts:read");
    const { id } = await params;
    // 404 for a host outside the caller's tag scope, as for a missing one.
    const hostId = parseRowId(id);
    const host = hostId === null ? null : await findProxyHostInScope(access, hostId);
    if (!host) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json(await getProxyHostHealth(host), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
