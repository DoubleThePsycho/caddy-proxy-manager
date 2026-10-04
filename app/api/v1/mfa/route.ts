import { NextRequest, NextResponse } from "next/server";
import { requireApiUser, apiErrorResponse } from "@/src/lib/api-auth";
import { getMfaStatus } from "@/src/lib/mfa";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * The caller's own multi-factor authentication state. Never includes the
 * authenticator secret or backup codes. Setting MFA up, turning it off and
 * new backup codes go through Better Auth's /api/auth/two-factor/* endpoints,
 * which need an interactive session and the password (documentation/mfa.md).
 */
export async function GET(request: NextRequest) {
  try {
    const { userId } = await requireApiUser(request);
    return NextResponse.json(await getMfaStatus(userId), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
