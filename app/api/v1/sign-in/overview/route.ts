import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { getSignInOverview } from "@/src/lib/sign-in-overview";

/**
 * GET /api/v1/sign-in/overview — enforced SSO, what the login page offers,
 * and every provider, directory and SCIM endpoint people sign in from, with
 * their accounts, role mappings, health and last activity. LDAP needs
 * ldap:read and SCIM scim:read; without them those parts are null.
 */
export async function GET(request: NextRequest) {
  try {
    const { access } = await requireApiPermission(request, "sso:read");
    return NextResponse.json(await getSignInOverview(access), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
