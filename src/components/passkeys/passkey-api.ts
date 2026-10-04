/**
 * Browser side of dashboard passkeys: the WebAuthn ceremonies through Better
 * Auth's /api/auth/passkey/* endpoints (src/lib/passkey-auth.ts), and the
 * management calls to /api/v1/passkeys. User verification (PIN or
 * biometrics) is always asked for; the server refuses passkeys without it.
 */
import { WebAuthnError, browserSupportsWebAuthn, startAuthentication, startRegistration } from "@simplewebauthn/browser";

export type PasskeyApiError = { status: number; code: string | null; message: string | null };
export type PasskeyApiResult<T> = { ok: true; data: T } | { ok: false; error: PasskeyApiError };

export type PasskeyItem = {
  id: number;
  name: string;
  authenticator: string | null;
  deviceType: string;
  backedUp: boolean;
  createdAt: string | null;
  lastUsedAt: string | null;
};

async function request<T>(path: string, init: RequestInit = {}): Promise<PasskeyApiResult<T>> {
  try {
    const response = await fetch(path, {
      credentials: "same-origin",
      ...init,
      headers: { ...(init.body ? { "Content-Type": "application/json" } : {}), ...(init.headers ?? {}) },
    });
    const data = response.status === 204 ? null : await response.json().catch(() => null);
    if (!response.ok) {
      const record = (data ?? {}) as Record<string, unknown>;
      return {
        ok: false,
        error: {
          status: response.status,
          code: typeof record.code === "string" ? record.code : null,
          message: typeof record.message === "string" ? record.message : typeof record.error === "string" ? record.error : null,
        },
      };
    }
    return { ok: true, data: data as T };
  } catch {
    return { ok: false, error: { status: 0, code: null, message: null } };
  }
}

function ceremonyError(error: unknown): PasskeyApiError {
  if (error instanceof WebAuthnError) {
    return { status: 400, code: error.code, message: null };
  }
  const name = error instanceof Error ? error.name : "";
  return { status: 400, code: name === "NotAllowedError" ? "ERROR_CEREMONY_ABORTED" : "WEBAUTHN_FAILED", message: null };
}

/** Whether this browser can use passkeys at all. */
export function passkeysSupported(): boolean {
  try {
    return browserSupportsWebAuthn();
  } catch {
    return false;
  }
}

/** Adds a passkey to the signed-in account: the browser ceremony, then verification with the account password. */
export async function addPasskey(password: string, name: string): Promise<PasskeyApiResult<unknown>> {
  const options = await request<Record<string, unknown>>("/api/auth/passkey/generate-register-options");
  if (!options.ok) return options;
  let response: Awaited<ReturnType<typeof startRegistration>>;
  try {
    response = await startRegistration({ optionsJSON: options.data as never });
  } catch (error) {
    return { ok: false, error: ceremonyError(error) };
  }
  const { clientExtensionResults: _extensions, ...body } = response;
  void _extensions;
  return request("/api/auth/passkey/verify-registration", {
    method: "POST",
    body: JSON.stringify({ response: body, password, ...(name.trim() ? { name: name.trim() } : {}) }),
  });
}

/** Signs in with a passkey (any account's: the authenticator chooses). */
export async function signInWithPasskey(): Promise<PasskeyApiResult<unknown>> {
  const options = await request<Record<string, unknown>>("/api/auth/passkey/generate-authenticate-options");
  if (!options.ok) return options;
  let response: Awaited<ReturnType<typeof startAuthentication>>;
  try {
    response = await startAuthentication({ optionsJSON: { ...options.data, userVerification: "required" } as never });
  } catch (error) {
    return { ok: false, error: ceremonyError(error) };
  }
  const { clientExtensionResults: _extensions, ...body } = response;
  void _extensions;
  return request("/api/auth/passkey/verify-authentication", { method: "POST", body: JSON.stringify({ response: body }) });
}

export const passkeyApi = {
  list: () => request<{ passkeys: PasskeyItem[]; canAdd: boolean; blocker: string | null }>("/api/v1/passkeys"),
  rename: (id: number, name: string) =>
    request<PasskeyItem>(`/api/v1/passkeys/${id}`, { method: "PATCH", body: JSON.stringify({ name }) }),
  remove: (id: number) => request<null>(`/api/v1/passkeys/${id}`, { method: "DELETE" }),
};

/** A short message for the person. */
export function describePasskeyError(error: PasskeyApiError): string {
  if (error.status === 0) return "Could not reach the server. Try again.";
  if (error.status === 429) return "Too many attempts. Wait a few minutes and try again.";
  switch (error.code) {
    case "ERROR_CEREMONY_ABORTED":
      return "The passkey request was cancelled or timed out.";
    case "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED":
      return "This passkey is already on your account.";
    case "INVALID_PASSWORD":
      return "Incorrect password.";
    case "USER_VERIFICATION_REQUIRED":
      return "This passkey did not ask for your PIN or biometrics. Use one that does.";
    case "SESSION_NOT_FRESH":
      return "Sign out and sign in again to add a passkey: your session is more than a day old.";
    case "PASSKEY_NOT_ALLOWED":
      return error.message ?? "Your account cannot add a passkey.";
    case "AUTHENTICATION_FAILED":
    case "PASSKEY_NOT_FOUND":
    case "CHALLENGE_NOT_FOUND":
      return "That passkey did not sign you in. Try again, or use another way to sign in.";
    case "WEBAUTHN_FAILED":
      return "The browser could not use a passkey here.";
    default:
      return error.message ?? "Something went wrong. Try again.";
  }
}
