import { NextRequest, NextResponse } from "next/server";
import { requireApiUser, apiErrorResponse } from "@/src/lib/api-auth";
import { listPasskeys, passkeyRegistrationBlocker } from "@/src/lib/passkeys";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * The caller's passkeys: names, kind, when they were added and last used.
 * Never the public key or the credential id. Adding one is a WebAuthn
 * ceremony in the browser through /api/auth/passkey/* (documentation/mfa.md).
 * A token with scopes is refused.
 */
export async function GET(request: NextRequest) {
  try {
    const { userId } = await requireApiUser(request);
    const blocker = await passkeyRegistrationBlocker(userId);
    return NextResponse.json({ passkeys: await listPasskeys(userId), canAdd: blocker === null, blocker }, { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
