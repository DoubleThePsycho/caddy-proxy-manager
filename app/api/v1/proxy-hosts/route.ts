import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { listProxyHosts, createProxyHost, toApiProxyHost } from "@/src/lib/models/proxy-hosts";
import { scopeTagsFor } from "@/src/lib/permissions";
import { readOrganizationFilterParam } from "@/ee/multi-tenancy/scope";
import {
  assertDomainsFreeOutsideScope,
  assertProxyHostWriteAllowed,
  tagsForWrite,
} from "@/src/lib/access-scope";
import { gateHostChange } from "@/ee/approvals/requests";

export async function GET(request: NextRequest) {
  try {
    const { access } = await requireApiPermission(request, "proxy_hosts:read");
    // Organisation users get their organisation's hosts; provider-level users can filter (?organizationId=).
    const organizationId = readOrganizationFilterParam(access, request.nextUrl.searchParams.get("organizationId"));
    const hosts = await listProxyHosts(scopeTagsFor(access, "proxy_hosts"), organizationId);
    return NextResponse.json(hosts.map(toApiProxyHost));
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const { userId, access } = await requireApiPermission(request, "proxy_hosts:write");
    const body = await request.json();
    const tags = tagsForWrite(access, "proxy_hosts", body?.tags, null);
    await assertProxyHostWriteAllowed(access, body ?? {}, null);
    await assertDomainsFreeOutsideScope(access, Array.isArray(body?.domains) ? body.domains : undefined, null);
    const input = { ...body, ...(tags !== undefined ? { tags } : {}) };
    // A host a change approval policy protects becomes a change request (202).
    const gate = await gateHostChange({ access, change: { targetType: "proxy_host", kind: "create", target: null, input: { host: input } } });
    if (gate) return NextResponse.json(gate.request, { status: 202 });
    const host = await createProxyHost(input, userId);
    return NextResponse.json(toApiProxyHost(host), { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
