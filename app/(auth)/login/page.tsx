import { redirect } from "next/navigation";
import { auth } from "@/src/lib/auth";
import { MFA_SETUP_PATH, mfaEnrolmentRequired } from "@/src/lib/mfa";
import { getProviderDisplayList } from "@/src/lib/models/oauth-providers";
import { oauthProviderHosts, samlProviderHosts } from "@/src/lib/login-providers";
import { anyPasskeyExists } from "@/src/lib/passkeys";
import { appDb } from "@/src/lib/db";
import { loginPageEnforcement } from "@/ee/sso/sign-in";
import { listLoginDirectories } from "@/ee/ldap/sso";
import { listLoginSamlProviders } from "@/ee/saml/store";
import LoginClient from "./LoginClient";

/** The message for a SAML sign-in that did not complete (ee/saml/plugin.ts); the reason is in the audit log. */
const SAML_ERROR_MESSAGE =
  "Single sign-on did not complete. Try again; if it keeps failing, ask your administrator to check the audit log.";

type LoginPageProps = { searchParams?: Promise<Record<string, string | string[] | undefined>> };

/** Reads that must never keep the login page from rendering. */
async function safely<T>(read: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await read();
  } catch {
    return fallback;
  }
}

export default async function LoginPage({ searchParams }: LoginPageProps = {}) {
  const session = await auth();
  if (session) {
    redirect(await mfaEnrolmentRequired(Number(session.user.id)) ? MFA_SETUP_PATH : "/");
  }

  const enabledProviders = await getProviderDisplayList();
  const { error } = (await searchParams) ?? {};
  // Where single sign-on sends the browser, shown on its button.
  const oauthHosts = await safely(oauthProviderHosts, new Map<string, string>());
  const samlHosts = await safely(samlProviderHosts, new Map<number, string>());
  const enforcement = await loginPageEnforcement(appDb);

  return (
    <LoginClient
      enabledProviders={enabledProviders.map((provider) => ({ ...provider, host: oauthHosts.get(provider.id) ?? null }))}
      ssoEnforced={enforcement.enforced}
      breakGlassSignIn={enforcement.breakGlass}
      directories={await listLoginDirectories(appDb)}
      samlProviders={(await listLoginSamlProviders(appDb)).map((provider) => ({ ...provider, host: samlHosts.get(provider.id) ?? null }))}
      // Passkey sign-in is offered once any account has a passkey.
      passkeysAvailable={await safely(async () => await anyPasskeyExists(), false)}
      initialError={error === "saml" ? SAML_ERROR_MESSAGE : null}
    />
  );
}
