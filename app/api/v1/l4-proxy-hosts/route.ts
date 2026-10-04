import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { listL4ProxyHosts, createL4ProxyHost } from "@/src/lib/models/l4-proxy-hosts";
import { scopeTagsFor } from "@/src/lib/permissions";
import { assertL4WriteAllowed, assertListenPortFreeOutsideScope, tagsForWrite } from "@/src/lib/access-scope";
import { gateHostChange } from "@/ee/approvals/requests";

export async function GET(request: NextRequest) {
  try {
    const { access } = await requireApiPermission(request, "l4_proxy_hosts:read");
    const hosts = await listL4ProxyHosts(scopeTagsFor(access, "l4_proxy_hosts"));
    return NextResponse.json(hosts);
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const { userId, access } = await requireApiPermission(request, "l4_proxy_hosts:write");
    const body = await request.json();
    const tags = tagsForWrite(access, "l4_proxy_hosts", body?.tags, null);
    assertL4WriteAllowed(access, body ?? {});
    await assertListenPortFreeOutsideScope(access, body?.protocol, body?.listenAddress, null);
    const input = { ...body, ...(tags !== undefined ? { tags } : {}) };
    // A host a change approval policy protects becomes a change request (202).
    const gate = await gateHostChange({ access, change: { targetType: "l4_proxy_host", kind: "create", target: null, input: { host: input } } });
    if (gate) return NextResponse.json(gate.request, { status: 202 });
    const host = await createL4ProxyHost(input, userId);
    return NextResponse.json(host, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
