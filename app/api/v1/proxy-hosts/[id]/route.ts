import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { updateProxyHost, deleteProxyHost, toApiProxyHost } from "@/src/lib/models/proxy-hosts";
import {
  assertDomainsFreeOutsideScope,
  assertProxyHostWriteAllowed,
  findProxyHostInScope,
  getProxyHostInScope,
  tagsForWrite,
} from "@/src/lib/access-scope";
import { gateHostChange } from "@/ee/approvals/requests";
import { routeRowId } from "@/src/lib/row-ids";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { access } = await requireApiPermission(request, "proxy_hosts:read");
    const { id } = await params;
    // 404 for a host outside the caller's tag scope, as for a missing one.
    const host = await findProxyHostInScope(access, routeRowId(id, "Not found"));
    if (!host) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json(toApiProxyHost(host));
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { userId, access } = await requireApiPermission(request, "proxy_hosts:write");
    const { id } = await params;
    const existing = await getProxyHostInScope(access, routeRowId(id));
    const body = await request.json();
    const tags = tagsForWrite(access, "proxy_hosts", body?.tags, existing.tags);
    await assertProxyHostWriteAllowed(access, body ?? {}, existing);
    await assertDomainsFreeOutsideScope(access, Array.isArray(body?.domains) ? body.domains : undefined, existing.id);
    const input = { ...body, ...(tags !== undefined ? { tags } : {}) };
    // A host a change approval policy protects: the change becomes a change request (202).
    const gate = await gateHostChange({ access, change: { targetType: "proxy_host", kind: "update", target: existing, input: { host: input } } });
    if (gate) return NextResponse.json(gate.request, { status: 202 });
    const host = await updateProxyHost(existing.id, input, userId);
    return NextResponse.json(toApiProxyHost(host));
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { userId, access } = await requireApiPermission(request, "proxy_hosts:write");
    const { id } = await params;
    const existing = await getProxyHostInScope(access, routeRowId(id));
    const gate = await gateHostChange({ access, change: { targetType: "proxy_host", kind: "delete", target: existing, input: {} } });
    if (gate) return NextResponse.json(gate.request, { status: 202 });
    await deleteProxyHost(existing.id, userId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
