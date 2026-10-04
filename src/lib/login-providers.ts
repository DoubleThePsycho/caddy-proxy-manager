/**
 * The host name of each enabled identity provider, for the login page's
 * single sign-on buttons ("Continue with Example SSO, auth.example.com"):
 * where the browser is about to be sent. OAuth/OIDC providers: the issuer,
 * or else the authorization URL; SAML providers: the single sign-on URL.
 * Nothing secret: the browser goes there anyway.
 */
import { eq } from "drizzle-orm";
import { appDb } from "./db";
import { oauthProviders, samlProviders } from "./db/schema";
import { asc } from "@/src/lib/db/ops";

function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

/** OAuth/OIDC provider id -> host name. */
export async function oauthProviderHosts(): Promise<Map<string, string>> {
  const rows = await appDb
    .select({ id: oauthProviders.id, issuer: oauthProviders.issuer, authorizationUrl: oauthProviders.authorizationUrl })
    .from(oauthProviders)
    .where(eq(oauthProviders.enabled, true))
    .orderBy(asc(oauthProviders.name), asc(oauthProviders.id));
  const hosts = new Map<string, string>();
  for (const row of rows) {
    const host = hostOf(row.issuer) ?? hostOf(row.authorizationUrl);
    if (host) hosts.set(row.id, host);
  }
  return hosts;
}

/** SAML provider id -> host name of its single sign-on URL. */
export async function samlProviderHosts(): Promise<Map<number, string>> {
  const rows = await appDb
    .select({ id: samlProviders.id, idpSsoUrl: samlProviders.idpSsoUrl })
    .from(samlProviders)
    .where(eq(samlProviders.enabled, true));
  const hosts = new Map<number, string>();
  for (const row of rows) {
    const host = hostOf(row.idpSsoUrl);
    if (host) hosts.set(row.id, host);
  }
  return hosts;
}
