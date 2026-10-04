import { randomUUID } from "node:crypto";
import { appDb, nowIso } from "../db";
import { oauthProviders } from "../db/schema";
import { eq } from "drizzle-orm";
import { encryptSecret, decryptSecret } from "../secret";
import { toOAuthProviderView, type OAuthProviderView } from "../oauth-provider-view";

export type OAuthProvider = {
  id: string;
  name: string;
  type: string;
  clientId: string;
  clientSecret: string;
  issuer: string | null;
  authorizationUrl: string | null;
  tokenUrl: string | null;
  userinfoUrl: string | null;
  scopes: string;
  autoLink: boolean;
  enabled: boolean;
  source: string;
  createdAt: string;
  updatedAt: string;
};

type DbProvider = typeof oauthProviders.$inferSelect;

function parseDbProvider(row: DbProvider): OAuthProvider {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    clientId: decryptSecret(row.clientId),
    clientSecret: decryptSecret(row.clientSecret),
    issuer: row.issuer,
    authorizationUrl: row.authorizationUrl,
    tokenUrl: row.tokenUrl,
    userinfoUrl: row.userinfoUrl,
    scopes: row.scopes,
    autoLink: row.autoLink,
    enabled: row.enabled,
    source: row.source,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function createOAuthProvider(data: {
  name: string;
  type?: string;
  clientId: string;
  clientSecret: string;
  issuer?: string | null;
  authorizationUrl?: string | null;
  tokenUrl?: string | null;
  userinfoUrl?: string | null;
  scopes?: string;
  autoLink?: boolean;
  enabled?: boolean;
  source?: string;
}): Promise<OAuthProvider> {
  const now = nowIso();
  const id = randomUUID();

  const [row] = await appDb
    .insert(oauthProviders)
    .values({
      id,
      name: data.name,
      type: data.type ?? "oidc",
      clientId: encryptSecret(data.clientId),
      clientSecret: encryptSecret(data.clientSecret),
      issuer: data.issuer ?? null,
      authorizationUrl: data.authorizationUrl ?? null,
      tokenUrl: data.tokenUrl ?? null,
      userinfoUrl: data.userinfoUrl ?? null,
      scopes: data.scopes ?? "openid email profile",
      autoLink: data.autoLink ?? false,
      enabled: data.enabled ?? true,
      source: data.source ?? "ui",
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  return parseDbProvider(row);
}

export async function listOAuthProviders(): Promise<OAuthProviderView[]> {
  const rows = await appDb.query.oauthProviders.findMany({
    orderBy: (table, { asc }) => [asc(table.name), asc(table.id)],
  });
  return rows.map((row) => toOAuthProviderView(parseDbProvider(row)));
}

export async function listEnabledOAuthProviders(): Promise<OAuthProvider[]> {
  const rows = await appDb.query.oauthProviders.findMany({
    where: (table, { eq }) => eq(table.enabled, true),
    orderBy: (table, { asc }) => [asc(table.name), asc(table.id)],
  });
  return rows.map(parseDbProvider);
}

export async function getOAuthProvider(id: string): Promise<OAuthProvider | null> {
  const row = await appDb.query.oauthProviders.findFirst({
    where: (table, { eq }) => eq(table.id, id),
  });
  return row ? parseDbProvider(row) : null;
}

export async function getOAuthProviderByName(name: string): Promise<OAuthProvider | null> {
  const row = await appDb.query.oauthProviders.findFirst({
    where: (table, { eq }) => eq(table.name, name),
  });
  return row ? parseDbProvider(row) : null;
}

export async function updateOAuthProvider(
  id: string,
  data: Partial<{
    name: string;
    type: string;
    clientId: string;
    clientSecret: string;
    issuer: string | null;
    authorizationUrl: string | null;
    tokenUrl: string | null;
    userinfoUrl: string | null;
    scopes: string;
    autoLink: boolean;
    enabled: boolean;
  }>
): Promise<OAuthProvider | null> {
  const now = nowIso();

  const updates: Record<string, unknown> = { updatedAt: now };

  if (data.name !== undefined) updates.name = data.name;
  if (data.type !== undefined) updates.type = data.type;
  if (data.clientId !== undefined) updates.clientId = encryptSecret(data.clientId);
  // A blank value means "preserve" at the server boundary as well as in the
  // UI. Rotation requires an explicit non-empty replacement.
  if (data.clientSecret !== undefined && data.clientSecret.trim().length > 0) {
    updates.clientSecret = encryptSecret(data.clientSecret.trim());
  }
  if (data.issuer !== undefined) updates.issuer = data.issuer;
  if (data.authorizationUrl !== undefined) updates.authorizationUrl = data.authorizationUrl;
  if (data.tokenUrl !== undefined) updates.tokenUrl = data.tokenUrl;
  if (data.userinfoUrl !== undefined) updates.userinfoUrl = data.userinfoUrl;
  if (data.scopes !== undefined) updates.scopes = data.scopes;
  if (data.autoLink !== undefined) updates.autoLink = data.autoLink;
  if (data.enabled !== undefined) updates.enabled = data.enabled;

  const [row] = await appDb
    .update(oauthProviders)
    .set(updates)
    .where(eq(oauthProviders.id, id))
    .returning();

  return row ? parseDbProvider(row) : null;
}

export async function deleteOAuthProvider(id: string): Promise<void> {
  const row = await appDb.query.oauthProviders.findFirst({
    where: (table, { eq }) => eq(table.id, id),
  });

  if (!row) {
    throw new Error("OAuth provider not found");
  }

  if (row.source === "env") {
    throw new Error("Cannot delete an environment-sourced OAuth provider");
  }

  await appDb.delete(oauthProviders).where(eq(oauthProviders.id, id));
}

export async function getProviderDisplayList(): Promise<
  Array<{ id: string; name: string; autoLink: boolean }>
> {
  const rows = await appDb.query.oauthProviders.findMany({
    where: (table, { eq }) => eq(table.enabled, true),
    orderBy: (table, { asc }) => [asc(table.name), asc(table.id)],
    columns: { id: true, name: true, autoLink: true },
  });
  return rows.map((r) => ({ id: r.id, name: r.name, autoLink: r.autoLink }));
}
