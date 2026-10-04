import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { listMtlsAccessRules, createMtlsAccessRule } from "@/src/lib/models/mtls-access-rules";
import { assertMtlsRuleReferencesAllowed, getProxyHostInScope } from "@/src/lib/access-scope";
import { gateHostChange, mtlsRuleFields } from "@/ee/approvals/requests";
import { routeRowId } from "@/src/lib/row-ids";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { access } = await requireApiPermission(request, "proxy_hosts:read");
    const { id } = await params;
    const host = await getProxyHostInScope(access, routeRowId(id));
    const rules = await listMtlsAccessRules(host.id);
    return NextResponse.json(rules);
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { userId, access } = await requireApiPermission(request, "proxy_hosts:write");
    const { id } = await params;
    const host = await getProxyHostInScope(access, routeRowId(id));
    const body = await request.json();
    if (!body.pathPattern || typeof body.pathPattern !== "string" || !body.pathPattern.trim()) {
      return NextResponse.json({ error: "pathPattern is required" }, { status: 400 });
    }
    assertMtlsRuleReferencesAllowed(access, body, null);
    // On a host a change approval policy protects, the change becomes a change request (202).
    const gate = await gateHostChange({
      access,
      change: {
        targetType: "proxy_host",
        kind: "update",
        target: host,
        input: { mtlsRule: { action: "create", input: { pathPattern: body.pathPattern, ...mtlsRuleFields(body) } } },
      },
    });
    if (gate) return NextResponse.json(gate.request, { status: 202 });
    const rule = await createMtlsAccessRule(
      { ...body, proxyHostId: host.id },
      userId
    );
    return NextResponse.json(rule, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
