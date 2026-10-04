/**
 * Browser calls to Better Auth's two-factor endpoints (/api/auth/two-factor/*)
 * for the login page, the MFA setup page and Profile. They use the session
 * cookie (or, for the second sign-in step, the two_factor challenge cookie).
 */

export type MfaApiError = { status: number; code: string | null; message: string | null };
export type MfaApiResult<T> = { ok: true; data: T } | { ok: false; error: MfaApiError };

export type MfaEnableResult = { totpURI: string; backupCodes: string[] };

async function post<T>(endpoint: string, body: Record<string, unknown>): Promise<MfaApiResult<T>> {
  try {
    const response = await fetch(`/api/auth/two-factor/${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!response.ok) {
      return {
        ok: false,
        error: {
          status: response.status,
          code: typeof data?.code === "string" ? data.code : null,
          message: typeof data?.message === "string" ? data.message : null,
        },
      };
    }
    return { ok: true, data: data as T };
  } catch {
    return { ok: false, error: { status: 0, code: null, message: null } };
  }
}

export const mfaApi = {
  /** Starts setting up an authenticator app; MFA stays off until verifyTotp confirms a code. */
  enable: (password: string) => post<MfaEnableResult>("enable", { password }),
  /** Confirms setup, or completes a sign-in with an authenticator code. */
  verifyTotp: (code: string) => post<unknown>("verify-totp", { code }),
  /** Completes a sign-in with a backup code (each works once). */
  verifyBackupCode: (code: string) => post<unknown>("verify-backup-code", { code }),
  disable: (password: string) => post<unknown>("disable", { password }),
  generateBackupCodes: (password: string) => post<{ backupCodes: string[] }>("generate-backup-codes", { password }),
};

/** Whether the second sign-in step has to start over from the password. */
export function signInChallengeEnded(error: MfaApiError): boolean {
  return error.code === "INVALID_TWO_FACTOR_COOKIE" || error.code === "TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE";
}

/** A short message for the person; deliberately generic about why a code was refused. */
export function describeMfaError(error: MfaApiError): string {
  if (error.status === 0) return "Could not reach the server. Try again.";
  if (error.status === 429) return "Too many attempts. Wait a few minutes and try again.";
  if (signInChallengeEnded(error)) return "Your sign-in expired or had too many attempts. Sign in again.";
  switch (error.code) {
    case "INVALID_PASSWORD":
      return "Incorrect password.";
    case "INVALID_CODE":
    case "INVALID_BACKUP_CODE":
      return "That code is not valid. Check it and try again.";
    case "MFA_REQUIRED_BY_POLICY":
      return error.message ?? "Your administrator requires multi-factor authentication for your account.";
    default:
      return "Something went wrong. Try again.";
  }
}

/** The base32 key in an otpauth:// URI, grouped for typing it into an authenticator app. */
export function manualEntryKey(totpURI: string): string {
  try {
    const secret = new URL(totpURI).searchParams.get("secret") ?? "";
    return secret.replace(/(.{4})/g, "$1 ").trim();
  } catch {
    return "";
  }
}
