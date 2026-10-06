import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { getMtlsAccessRule, updateMtlsAccessRule, deleteMtlsAccessRule } from "@/src/lib/models/mtls-access-rules";
import { assertMtlsRuleReferencesAllowed, getProxyHostInScope } from "@/src/lib/access-scope";
import type { Access } from "@/src/lib/permissions";
import { gateHostChange, mtlsRuleFields } from "@/ee/approvals/requests";
import { parseRowId } from "@/src/lib/row-ids";

/** The rule and its host, or null when it is missing or its proxy host is outside the caller's scope. */
async function getRuleInScope(access: Access, rawRuleId: string) {
  const ruleId = parseRowId(rawRuleId);
  const rule = ruleId === null ? null : await getMtlsAccessRule(ruleId);
  if (!rule) return null;
  const host = await getProxyHostInScope(access, rule.proxyHostId);
  return { rule, host };
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; ruleId: string }> }
) {
  try {
    const { access } = await requireApiPermission(request, "proxy_hosts:read");
    const { ruleId } = await params;
    const found = await getRuleInScope(access, ruleId);
    if (!found) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json(found.rule);
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; ruleId: string }> }
) {
  try {
    const { userId, access } = await requireApiPermission(request, "proxy_hosts:write");
    const { ruleId } = await params;
    const found = await getRuleInScope(access, ruleId);
    if (!found) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const { rule, host } = found;
    const body = await request.json();
    assertMtlsRuleReferencesAllowed(access, body ?? {}, rule);
    // On a host a change approval policy protects, the change becomes a change request (202).
    const gate = await gateHostChange({
      access,
      change: { targetType: "proxy_host", kind: "update", target: host, input: { mtlsRule: { action: "update", ruleId: rule.id, input: mtlsRuleFields(body) } } },
    });
    if (gate) return NextResponse.json(gate.request, { status: 202 });
    // updateMtlsAccessRule never moves a rule to another host.
    const updated = await updateMtlsAccessRule(rule.id, body, userId);
    return NextResponse.json(updated);
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; ruleId: string }> }
) {
  try {
    const { userId, access } = await requireApiPermission(request, "proxy_hosts:write");
    const { ruleId } = await params;
    const found = await getRuleInScope(access, ruleId);
    if (!found) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const { rule, host } = found;
    const gate = await gateHostChange({
      access,
      change: { targetType: "proxy_host", kind: "update", target: host, input: { mtlsRule: { action: "delete", ruleId: rule.id } } },
    });
    if (gate) return NextResponse.json(gate.request, { status: 202 });
    await deleteMtlsAccessRule(rule.id, userId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
