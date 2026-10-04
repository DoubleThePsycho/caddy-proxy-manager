import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission } from "@/src/lib/api-auth";
import { ApiClientError } from "@/src/lib/api-errors";
import { explainWafEvent } from "@/src/lib/waf-event-explain";
import { WafExplainError } from "@/src/lib/waf-explain";
import { WAF_NO_STORE, wafErrorResponse } from "@/src/lib/waf-api";

type Context = { params: Promise<{ id: string }> };

/** Why a request was blocked: the matched rules, their anomaly points, the score against the threshold and the deciding rule. */
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
    return NextResponse.json(explanation, { headers: WAF_NO_STORE });
  } catch (error) {
    return wafErrorResponse(error);
  }
}
