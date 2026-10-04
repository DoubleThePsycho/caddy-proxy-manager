import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission } from "@/src/lib/api-auth";
import { ApiClientError } from "@/src/lib/api-errors";
import { applyCaddyConfig } from "@/src/lib/caddy";
import { deleteWafExclusion, getWafExclusion, updateWafExclusion } from "@/src/lib/models/waf-exclusions";
import { onlyFields, parseIdParam, readJsonObject, WAF_NO_STORE, wafErrorResponse } from "@/src/lib/waf-api";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: Context) {
  try {
    await requireApiPermission(request, "waf:read");
    const id = parseIdParam((await params).id, "id");
    const exclusion = await getWafExclusion(id);
    if (!exclusion) throw new ApiClientError("WAF exclusion not found", 404);
    return NextResponse.json(exclusion, { headers: WAF_NO_STORE });
  } catch (error) {
    return wafErrorResponse(error);
  }
}

/** Changes the reason, path or variable; the rule and scope of an exclusion never change. */
export async function PATCH(request: NextRequest, { params }: Context) {
  try {
    const { userId } = await requireApiPermission(request, "waf:write");
    const id = parseIdParam((await params).id, "id");
    const body = await readJsonObject(request);
    onlyFields(body, ["path", "pathMatch", "variable", "reason", "ruleId", "proxyHostId"]);
    const exclusion = await updateWafExclusion(id, body, userId, { apply: applyCaddyConfig });
    return NextResponse.json(exclusion, { headers: WAF_NO_STORE });
  } catch (error) {
    return wafErrorResponse(error);
  }
}

export async function DELETE(request: NextRequest, { params }: Context) {
  try {
    const { userId } = await requireApiPermission(request, "waf:write");
    const id = parseIdParam((await params).id, "id");
    await deleteWafExclusion(id, userId, { apply: applyCaddyConfig });
    return NextResponse.json({ ok: true }, { headers: WAF_NO_STORE });
  } catch (error) {
    return wafErrorResponse(error);
  }
}
