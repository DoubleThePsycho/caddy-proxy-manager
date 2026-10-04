/**
 * Database start-up: register() in src/instrumentation.ts runs it after the
 * configuration check and the leader watchdog, before any job.
 *
 * SQLite: opening the database (src/lib/db/sqlite.ts) runs the schema
 * migrations and the legacy schema repairs. This then runs the one-time data
 * migrations that src/lib/db.ts used to run when it was first imported. They
 * are idempotent (each records a flag in `settings`) and skipped on a high
 * availability standby, whose read-only copy the leader migrated, and on an
 * in-memory database.
 *
 * PostgreSQL: pg-startup.ts checks the server and the database, applies
 * drizzle-pg/ under an advisory lock, and the data migrations run under the
 * same lock. A database that cannot be used stops the server.
 */
import { and, desc, eq, isNull, ne } from "drizzle-orm";
import { CREDENTIAL_ACCOUNT_ISSUER, resolveOAuthAccountIssuer } from "../account-issuer";
import { ownEmailUsername } from "../sign-in-names";
import { clearOrphanedRowsAtStartup } from "../models/orphaned-rows";
import { HA_WITH_POSTGRES_MESSAGE, isHaEnabled } from "@/ee/high-availability/cluster/config";
import { isPostgres } from "./dialect";
import { appDb, getAppExecutor } from "./executor";
import { first } from "./ops";
import { DatabaseStartupError, preparePostgresDatabase } from "./pg-startup";
import { getPostgresPool } from "./postgres";
import * as schema from "./schema";
import { readOnlyCopy, sqlitePath, vacuumSqliteDatabase } from "./sqlite";
import type { AppDb } from "./types";

/**
 * One-time migration: populate `accounts` table from existing users' provider/subject fields.
 * Also creates credential accounts for password users and syncs env OAuth providers.
 * Idempotent — skips if already run (checked via settings flag).
 */
async function runBetterAuthDataMigration(db: AppDb): Promise<void> {
  const { settings, users, accounts, oauthProviders } = schema;

  const flag = await first(db.select().from(settings).where(eq(settings.key, "better_auth_migrated")));
  if (flag) return;

  const now = new Date().toISOString();
  // What changed, for the log line: a new database has nothing to migrate.
  let migrated = 0;

  // Migrate OAuth users: create account rows from users.provider/subject
  const oauthUsers = await db.select().from(users).where(ne(users.provider, "credentials")).orderBy(users.id);
  for (const user of oauthUsers) {
    if (!user.provider || !user.subject) continue;
    const existing = await first(db.select().from(accounts).where(
      and(eq(accounts.userId, user.id), eq(accounts.providerId, user.provider), eq(accounts.accountId, user.subject))
    ));
    if (!existing) {
      const configuredProvider = await first(db.select({ issuer: oauthProviders.issuer })
        .from(oauthProviders)
        .where(eq(oauthProviders.id, user.provider)));
      await db.insert(accounts).values({
        userId: user.id,
        issuer: resolveOAuthAccountIssuer(user.provider, configuredProvider?.issuer),
        accountId: user.subject,
        providerId: user.provider,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      });
      migrated += 1;
    }
  }

  // Migrate credentials users: create credential account rows
  const credentialUsers = await db.select().from(users).where(eq(users.provider, "credentials")).orderBy(users.id);
  for (const user of credentialUsers) {
    const existing = await first(db.select().from(accounts).where(
      and(eq(accounts.userId, user.id), eq(accounts.providerId, "credential"))
    ));
    if (!existing) {
      await db.insert(accounts).values({
        userId: user.id,
        issuer: CREDENTIAL_ACCOUNT_ISSUER,
        accountId: user.id.toString(),
        providerId: "credential",
        password: user.passwordHash,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      });
      migrated += 1;
    }
  }

  // Give users without a username their own email address as one when
  // ownEmailUsername allows it; the others keep none.
  const usersWithoutUsername = await db.select().from(users).where(isNull(users.username)).orderBy(users.id);
  for (const user of usersWithoutUsername) {
    const displayUsername = user.email.split("@")[0] || user.email;
    // Checked against every username set so far (nothing else writes during start-up).
    const username = await ownEmailUsername(db, user.id, user.email);
    await db.update(users).set({ username, displayUsername }).where(eq(users.id, user.id));
    migrated += 1;
  }

  await db.insert(settings).values({ key: "better_auth_migrated", value: "true", updatedAt: now });
  if (migrated > 0) console.log("Better Auth data migration complete: populated accounts table");
}

type OAuthEnvConfig = {
  oauth: {
    enabled: boolean;
    providerName: string;
    clientId: string | null;
    clientSecret: string | null;
    issuer: string | null;
    authorizationUrl: string | null;
    tokenUrl: string | null;
    userinfoUrl: string | null;
    allowAutoLinking: boolean;
  };
};

/** Sync OAUTH_* env vars into the oauthProviders table. */
async function runEnvProviderSync(db: AppDb): Promise<void> {
  // Loaded here so a configuration that does not load leaves the providers alone.
  let config: OAuthEnvConfig;
  try {
    config = (await import("../config")).config;
  } catch {
    return;
  }

  if (!config.oauth.enabled || !config.oauth.clientId || !config.oauth.clientSecret) return;

  const { oauthProviders } = schema;
  let encryptSecret: (v: string) => string;
  try {
    encryptSecret = (await import("../secret")).encryptSecret;
  } catch (e) {
    console.error("CRITICAL: Failed to load encryption module, refusing to store plaintext secrets:", e);
    return;
  }

  const name = config.oauth.providerName;
  // Use a slug-based ID so the OAuth callback URL is predictable
  const providerId = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "oauth";
  const existing = await first(db.select().from(oauthProviders).where(eq(oauthProviders.name, name)));

  const now = new Date().toISOString();
  if (existing && existing.source === "env") {
    await db.update(oauthProviders).set({
      clientId: encryptSecret(config.oauth.clientId),
      clientSecret: encryptSecret(config.oauth.clientSecret),
      issuer: config.oauth.issuer ?? null,
      authorizationUrl: config.oauth.authorizationUrl ?? null,
      tokenUrl: config.oauth.tokenUrl ?? null,
      userinfoUrl: config.oauth.userinfoUrl ?? null,
      autoLink: config.oauth.allowAutoLinking,
      updatedAt: now,
    }).where(eq(oauthProviders.id, existing.id));
  } else if (!existing) {
    await db.insert(oauthProviders).values({
      id: providerId,
      name,
      type: "oidc",
      clientId: encryptSecret(config.oauth.clientId),
      clientSecret: encryptSecret(config.oauth.clientSecret),
      issuer: config.oauth.issuer ?? null,
      authorizationUrl: config.oauth.authorizationUrl ?? null,
      tokenUrl: config.oauth.tokenUrl ?? null,
      userinfoUrl: config.oauth.userinfoUrl ?? null,
      scopes: "openid email profile",
      autoLink: config.oauth.allowAutoLinking,
      enabled: true,
      source: "env",
      createdAt: now,
      updatedAt: now,
    });
    console.log(`Synced OAuth provider from env: ${name}`);
  }
}

/**
 * One-time migration: convert legacy Cloudflare DNS settings to the new
 * generic dns_provider format.  Idempotent — skips if already run or if
 * the new setting already exists.
 */
async function runCloudflareToProviderMigration(db: AppDb): Promise<void> {
  const { settings: settingsTable } = schema;

  // Skip if migration already ran
  const flag = await first(db.select().from(settingsTable).where(eq(settingsTable.key, "dns_provider_migrated")));
  if (flag) return;

  // Skip if new dns_provider setting already exists (user already configured it)
  const existing = await first(db.select().from(settingsTable).where(eq(settingsTable.key, "dns_provider")));
  if (existing) {
    const now = new Date().toISOString();
    await db.insert(settingsTable).values({ key: "dns_provider_migrated", value: "true", updatedAt: now });
    return;
  }

  // Check for legacy cloudflare setting
  const cfRow = await first(db.select().from(settingsTable).where(eq(settingsTable.key, "cloudflare")));
  if (!cfRow) {
    const now = new Date().toISOString();
    await db.insert(settingsTable).values({ key: "dns_provider_migrated", value: "true", updatedAt: now });
    return;
  }

  try {
    const cf = JSON.parse(cfRow.value) as { apiToken?: string; zoneId?: string; accountId?: string };
    if (cf.apiToken) {
      const now = new Date().toISOString();
      const newSetting = {
        providers: { cloudflare: { api_token: cf.apiToken } },
        default: "cloudflare",
      };
      await db.insert(settingsTable).values({ key: "dns_provider", value: JSON.stringify(newSetting), updatedAt: now });
      console.log("Migrated legacy Cloudflare DNS settings to dns_provider format");
    }
  } catch (e) {
    console.warn("Failed to parse legacy cloudflare setting during migration:", e);
  }

  const now = new Date().toISOString();
  await db.insert(settingsTable).values({ key: "dns_provider_migrated", value: "true", updatedAt: now });
}

/**
 * One-time repair (#261): re-derive `users.provider` / `users.subject` from the
 * authoritative `accounts` table. Deployments that linked or unlinked OAuth
 * identities before the sync hook existed carry stale values, which made the
 * Profile page report the wrong connection state.
 */
async function runOAuthIdentityRepair(db: AppDb): Promise<void> {
  const flag = await first(db.select().from(schema.settings).where(eq(schema.settings.key, "oauth_identity_sync_repaired")));
  if (flag) return;

  const allUsers = await db
    .select({ id: schema.users.id, provider: schema.users.provider, subject: schema.users.subject })
    .from(schema.users)
    .orderBy(schema.users.id);
  // Users whose provider or subject changed, for the log line.
  let repaired = 0;
  for (const user of allUsers) {
    const [oauthAccount] = await db
      .select({ providerId: schema.accounts.providerId, accountId: schema.accounts.accountId })
      .from(schema.accounts)
      .where(and(eq(schema.accounts.userId, user.id), ne(schema.accounts.providerId, "credential")))
      .orderBy(desc(schema.accounts.id))
      .limit(1);

    if (oauthAccount) {
      if (user.provider === oauthAccount.providerId && user.subject === oauthAccount.accountId) continue;
      await db.update(schema.users)
        .set({ provider: oauthAccount.providerId, subject: oauthAccount.accountId, updatedAt: new Date().toISOString() })
        .where(eq(schema.users.id, user.id));
      repaired += 1;
      continue;
    }

    const credentialAccount = await first(db
      .select({ id: schema.accounts.id })
      .from(schema.accounts)
      .where(and(eq(schema.accounts.userId, user.id), eq(schema.accounts.providerId, "credential"))));
    const row = await first(db.select({ passwordHash: schema.users.passwordHash }).from(schema.users).where(eq(schema.users.id, user.id)));
    const hasCredential = !!credentialAccount || !!row?.passwordHash;
    const provider = hasCredential ? "credentials" : null;
    if (user.provider === provider && user.subject === null) continue;
    await db.update(schema.users)
      .set({ provider, subject: null, updatedAt: new Date().toISOString() })
      .where(eq(schema.users.id, user.id));
    repaired += 1;
  }

  await db.insert(schema.settings).values({ key: "oauth_identity_sync_repaired", value: "true", updatedAt: new Date().toISOString() });
  if (repaired > 0) console.log("OAuth identity repair complete: users.provider/subject re-derived from accounts");
}

/** The one-time data migrations. A failing one is logged and does not stop the server, as before. */
async function runDataMigrations(db: AppDb): Promise<void> {
  try {
    await runBetterAuthDataMigration(db);
    await runEnvProviderSync(db);
    await runCloudflareToProviderMigration(db);
    await runOAuthIdentityRepair(db);
  } catch (error) {
    console.warn("Better Auth data migration warning:", error);
  }
  // Every start (idempotent): rows older releases left behind when they
  // deleted the row they belong to (src/lib/models/orphaned-rows.ts).
  await clearOrphanedRowsAtStartup(db);
}

/**
 * Prepares the database before the server does anything else: on SQLite the
 * schema is migrated when the database is opened, on PostgreSQL here; then
 * the one-time data migrations run.
 */
export async function runDatabaseStartup(): Promise<void> {
  if (isPostgres()) {
    // The high availability cluster replicates a SQLite file (D15).
    if (isHaEnabled()) throw new DatabaseStartupError(HA_WITH_POSTGRES_MESSAGE);
    await preparePostgresDatabase(getPostgresPool(), { then: () => runDataMigrations(appDb) });
    return;
  }
  getAppExecutor();

  // A standby's copy is read-only; the leader ran these on the same data.
  if (readOnlyCopy || sqlitePath === ":memory:") return;
  await runDataMigrations(appDb);
}

/**
 * VACUUMs the SQLite database once (or when `force` is set: a start-up
 * migration just rewrote secrets) so content deleted before secure_delete was
 * on no longer remains in its free pages. Waits for open transactions first.
 * Returns whether it ran. PostgreSQL has no equivalent (documented instead).
 */
export async function purgeDeletedDatabaseContent(force = false): Promise<boolean> {
  if (isPostgres() || sqlitePath === ":memory:") return false;
  return getAppExecutor().runExclusive(() => vacuumSqliteDatabase(force));
}
