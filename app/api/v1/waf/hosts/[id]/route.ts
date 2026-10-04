import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission } from "@/src/lib/api-auth";
import { ApiClientError, ApiValidationError } from "@/src/lib/api-errors";
import { getWafHostView, setWafHostMode } from "@/src/lib/waf-hosts";
import { isWafHostMode, WAF_HOST_MODES } from "@/src/lib/waf-host-mode";
import { onlyFields, parseIdParam, readJsonObject, WAF_NO_STORE, wafErrorResponse } from "@/src/lib/waf-api";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: Context) {
  try {
    await requireApiPermission(request, "waf:read");
    const view = await getWafHostView(parseIdParam((await params).id, "id"));
    if (!view) throw new ApiClientError("Proxy host not found", 404);
    return NextResponse.json(view, { headers: WAF_NO_STORE });
  } catch (error) {
    return wafErrorResponse(error);
  }
}

/** Sets the host's WAF mode (inherit, off, detection_only or block); the rest of its WAF settings stay. */
export async function PUT(request: NextRequest, { params }: Context) {
  try {
    const { userId } = await requireApiPermission(request, "waf:write");
    const id = parseIdParam((await params).id, "id");
    const body = await readJsonObject(request);
    onlyFields(body, ["mode"]);
    if (!isWafHostMode(body.mode)) throw new ApiValidationError(`mode must be one of ${WAF_HOST_MODES.join(", ")}`);
    return NextResponse.json(await setWafHostMode(id, body.mode, userId), { headers: WAF_NO_STORE });
  } catch (error) {
    return wafErrorResponse(error);
  }
}
