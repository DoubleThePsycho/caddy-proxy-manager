import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission } from "@/src/lib/api-auth";
import { ApiValidationError } from "@/src/lib/api-errors";
import { applyCaddyConfig } from "@/src/lib/caddy";
import { createWafExclusion, listWafExclusions, type WafExclusionFilter } from "@/src/lib/models/waf-exclusions";
import { onlyFields, parseIdParam, readJsonObject, WAF_NO_STORE, wafErrorResponse } from "@/src/lib/waf-api";

function readFilter(searchParams: URLSearchParams): WafExclusionFilter {
  const filter: WafExclusionFilter = {};
  const scope = searchParams.get("scope");
  const hostId = searchParams.get("proxyHostId");
  const ruleId = searchParams.get("ruleId");
  if (scope !== null && scope !== "global" && scope !== "host") throw new ApiValidationError("scope must be global or host");
  if (scope === "global" && hostId !== null) throw new ApiValidationError("scope=global takes no proxyHostId");
  if (scope === "global") filter.proxyHostId = null;
  if (hostId !== null) filter.proxyHostId = parseIdParam(hostId, "proxyHostId");
  if (ruleId !== null) filter.ruleId = parseIdParam(ruleId, "ruleId");
  return filter;
}

/** Lists rule exclusions, oldest first. `scope=host` without a host lists every host's. */
export async function GET(request: NextRequest) {
  try {
    await requireApiPermission(request, "waf:read");
    const { searchParams } = request.nextUrl;
    const exclusions = await listWafExclusions(readFilter(searchParams));
    const scope = searchParams.get("scope");
    const listed = scope === "host" ? exclusions.filter((exclusion) => exclusion.scope === "host") : exclusions;
    return NextResponse.json({ exclusions: listed }, { headers: WAF_NO_STORE });
  } catch (error) {
    return wafErrorResponse(error);
  }
}

/** Adds an exclusion and applies the configuration (undone if Caddy refuses it). */
export async function POST(request: NextRequest) {
  try {
    const { userId } = await requireApiPermission(request, "waf:write");
    const body = await readJsonObject(request);
    onlyFields(body, ["ruleId", "proxyHostId", "path", "pathMatch", "variable", "reason"]);
    const exclusion = await createWafExclusion(body, userId, { apply: applyCaddyConfig });
    return NextResponse.json(exclusion, { status: 201, headers: WAF_NO_STORE });
  } catch (error) {
    return wafErrorResponse(error);
  }
}
