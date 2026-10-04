import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission } from "@/src/lib/api-auth";
import { ApiClientError } from "@/src/lib/api-errors";
import { explainWafEvent } from "@/src/lib/waf-event-explain";
import { WafExplainError } from "@/src/lib/waf-explain";
import { WAF_NO_STORE, wafErrorResponse } from "@/src/lib/waf-api";

type Context = { params: Promise<{ id: string }> };

/**
 * The narrowest exclusion for each rule that added to the event's anomaly
 * score: the rule, on the proxy host that served the request, for its path,
 * on the matched variable when the record names one. Post one to
 * /api/v1/waf/exclusions to create it. Nothing is changed here.
 */
export async function GET(request: NextRequest, { params }: Context) {
  try {
    await requireApiPermission(request, "waf:read");
    const { id } = await params;
    let explanation;
    try {
      explanation = await explainWafEvent(id);
    } catch (error) {
      if (error instanceof WafExplainError) throw new ApiClientError(error.message, 422);
      throw error;
    }
    if (!explanation) throw new ApiClientError("WAF event not found", 404);
    return NextResponse.json({ eventId: id, suggestions: explanation.suggestions }, { headers: WAF_NO_STORE });
  } catch (error) {
    return wafErrorResponse(error);
  }
}
