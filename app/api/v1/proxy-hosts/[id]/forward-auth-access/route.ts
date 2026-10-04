import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import {
  getForwardAuthAccessForHost,
  setForwardAuthAccess
} from "@/src/lib/models/forward-auth";
import { assertForwardAuthAccessAllowed, getProxyHostInScope } from "@/src/lib/access-scope";
import { gateHostChange } from "@/ee/approvals/requests";
import { routeRowId } from "@/src/lib/row-ids";

type Params = { params: Promise<{ id: string }> };

function ids(value: unknown): number[] {
  return Array.isArray(value) ? value.filter((id): id is number => Number.isSafeInteger(id) && id > 0) : [];
}

function grantedIds(entries: Awaited<ReturnType<typeof getForwardAuthAccessForHost>>) {
  return {
    userIds: entries.filter((entry) => entry.userId !== null).map((entry) => entry.userId!),
    groupIds: entries.filter((entry) => entry.groupId !== null).map((entry) => entry.groupId!),
  };
}

export async function GET(request: NextRequest, { params }: Params) {
  try {
    const { access } = await requireApiPermission(request, "proxy_hosts:read");
    const { id } = await params;
    const host = await getProxyHostInScope(access, routeRowId(id));
    const entries = await getForwardAuthAccessForHost(host.id);
    return NextResponse.json(entries);
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PUT(request: NextRequest, { params }: Params) {
  try {
    const { userId, access } = await requireApiPermission(request, "proxy_hosts:write");
    const { id } = await params;
    const host = await getProxyHostInScope(access, routeRowId(id));
    const body = await request.json();
    const next = { userIds: body.userIds, groupIds: body.groupIds };
    await assertForwardAuthAccessAllowed(
      access,
      { userIds: next.userIds ?? [], groupIds: next.groupIds ?? [] },
      grantedIds(await getForwardAuthAccessForHost(host.id))
    );
    // On a host a change approval policy protects, the change becomes a change request (202).
    const gate = await gateHostChange({
      access,
      change: {
        targetType: "proxy_host",
        kind: "update",
        target: host,
        input: { forwardAuthAccess: { userIds: ids(next.userIds), groupIds: ids(next.groupIds) } },
      },
    });
    if (gate) return NextResponse.json(gate.request, { status: 202 });
    const entries = await setForwardAuthAccess(host.id, next, userId);
    return NextResponse.json(entries);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
