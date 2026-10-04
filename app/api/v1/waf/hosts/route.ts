import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission } from "@/src/lib/api-auth";
import { listWafHostViews } from "@/src/lib/waf-hosts";
import { WAF_NO_STORE, wafErrorResponse } from "@/src/lib/waf-api";

/** Every proxy host with its WAF mode setting and what it gets. */
export async function GET(request: NextRequest) {
  try {
    await requireApiPermission(request, "waf:read");
    return NextResponse.json({ hosts: await listWafHostViews() }, { headers: WAF_NO_STORE });
  } catch (error) {
    return wafErrorResponse(error);
  }
}
