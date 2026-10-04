// SPDX-License-Identifier: Elastic-2.0
/** The login page's directory sign-in, in the browser. */

/** A sign-in answer, as Better Auth's client returns it for the password sign-in. */
export type SignInResult = {
  data: { twoFactorRedirect?: boolean; twoFactorMethods?: string[] } | null;
  error: { status?: number; message?: string } | null;
};

/** Directory sign-in (ee/ldap): POST /api/auth/sign-in/ldap, answered like the password sign-in. */
export async function signInWithDirectory(directoryId: number, username: string, password: string): Promise<SignInResult> {
  try {
    const response = await fetch("/api/auth/sign-in/ldap", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ directoryId, username, password }),
    });
    const body = (await response.json().catch(() => null)) as { message?: string; twoFactorRedirect?: boolean; twoFactorMethods?: string[] } | null;
    if (!response.ok) return { data: null, error: { status: response.status, message: body?.message } };
    return { data: body, error: null };
  } catch {
    return { data: null, error: { message: "Sign-in failed. Try again." } };
  }
}
