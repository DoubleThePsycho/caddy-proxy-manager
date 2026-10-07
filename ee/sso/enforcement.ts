// SPDX-License-Identifier: Elastic-2.0
/**
 * Enforced SSO: reading and changing the setting. Enforcing it at sign-in is
 * in ee/sso/sign-in.ts.
 */
import { and, eq, isNotNull, ne } from "drizzle-orm";
import { appDb } from "@/src/lib/db";
import { accounts, oauthProviders, samlProviders, users } from "@/src/lib/db/schema";
import { isUsableSignInUsername } from "@/src/lib/login-username";
import { ApiValidationError } from "@/src/lib/api-errors";
import { logAuditEvent } from "@/src/lib/audit";
import { samlProviderId } from "@/ee/saml/constants";
import {
  MAX_BREAK_GLASS_ACCOUNTS,
  canAnyBreakGlassSignIn,
  describeBreakGlassAccounts,
  passwordSignInUsername,
  readSsoEnforcement,
  writeSsoEnforcement,
  type BreakGlassAccount,
  type SsoEnforcementConfig,
  type SsoReader,
} from "./enforcement-store";
import { asc, first } from "@/src/lib/db/ops";

/** An enabled sign-in provider; SAML providers carry their accounts.providerId ("saml:<id>"). */
export type SsoProviderSummary = { id: string; name: string; kind: "oidc" | "saml" };

export type SsoEnforcementView = {
  enabled: boolean;
  /** Sign-in usernames of the break-glass accounts that exist. */
  breakGlassUsernames: string[];
  breakGlassAccounts: BreakGlassAccount[];
  /** Enabled identity providers people can sign in with while SSO is enforced. */
  ssoProviders: SsoProviderSummary[];
  /** Problems with the current setting worth showing an administrator. */
  warnings: string[];
};

export type SsoEnforcementInput = {
  enabled: boolean;
  /** Omitted: keep the current break-glass accounts. */
  breakGlassUsernames?: string[];
};

const MAX_USERNAME_LENGTH = 255;

/** The enabled sign-in providers enforcement leaves open: OAuth/OIDC and SAML (ee/saml). */
export async function listEnabledSsoProviders(reader: SsoReader): Promise<SsoProviderSummary[]> {
  const oidc = (await reader
    .select({ id: oauthProviders.id, name: oauthProviders.name })
    .from(oauthProviders)
    .where(eq(oauthProviders.enabled, true))
    .orderBy(asc(oauthProviders.name), asc(oauthProviders.id)))
    .map((row) => ({ id: row.id, name: row.name, kind: "oidc" as const }));
  const saml = (await reader
    .select({ id: samlProviders.id, name: samlProviders.name })
    .from(samlProviders)
    .where(eq(samlProviders.enabled, true))
    .orderBy(asc(samlProviders.name), asc(samlProviders.id)))
    .map((row) => ({ id: samlProviderId(row.id), name: row.name, kind: "saml" as const }));
  return [...oidc, ...saml].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function buildWarnings(config: SsoEnforcementConfig, accounts: BreakGlassAccount[], providers: SsoProviderSummary[]): string[] {
  const warnings: string[] = [];
  for (const account of accounts) {
    if (!account.passwordSignIn) {
      warnings.push(`Break-glass account ${account.username ?? account.email} cannot sign in with a password.`);
    }
  }
  if (!config.enabled) return warnings;
  if (providers.length === 0) {
    warnings.push(canAnyBreakGlassSignIn(accounts)
      ? "No OAuth/OIDC or SAML provider is enabled, so only break-glass accounts can sign in."
      : "No OAuth/OIDC or SAML provider is enabled and no break-glass account can sign in. Enable a provider or turn enforced SSO off.");
  }
  return warnings;
}

export async function getSsoEnforcementView(): Promise<SsoEnforcementView> {
  const config = await readSsoEnforcement(appDb);
  const accounts = await describeBreakGlassAccounts(appDb, config.breakGlassUserIds);
  const providers = await listEnabledSsoProviders(appDb);
  return {
    enabled: config.enabled,
    breakGlassUsernames: accounts.map((account) => account.username).filter((name): name is string => !!name),
    breakGlassAccounts: accounts,
    ssoProviders: providers,
    warnings: buildWarnings(config, accounts, providers),
  };
}

export type BreakGlassCandidate = {
  id: number;
  username: string;
  name: string | null;
  email: string;
  role: string;
  status: string;
};

/** Accounts that can sign in on the login page with a password: the ones that can be break-glass accounts. */
export async function listBreakGlassCandidates(reader: SsoReader = appDb): Promise<BreakGlassCandidate[]> {
  const rows = await reader
    .select({
      id: users.id,
      username: users.username,
      name: users.name,
      email: users.email,
      role: users.role,
      status: users.status,
    })
    .from(users)
    .innerJoin(accounts, eq(accounts.userId, users.id))
    .where(and(eq(accounts.providerId, "credential"), isNotNull(accounts.password), ne(accounts.password, "")))
    .orderBy(asc(users.username), asc(users.id));
  const candidates = new Map<number, BreakGlassCandidate>();
  for (const row of rows) {
    if (isUsableSignInUsername(row.username)) candidates.set(row.id, { ...row, username: row.username });
  }
  return [...candidates.values()];
}

/** Validates a PUT body or form submission. Throws ApiValidationError (400). */
export function parseSsoEnforcementInput(body: unknown): SsoEnforcementInput {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new ApiValidationError("Body must be a JSON object");
  }
  const record = body as Record<string, unknown>;
  if (typeof record.enabled !== "boolean") {
    throw new ApiValidationError("enabled must be true or false");
  }
  if (record.breakGlassUsernames === undefined) {
    return { enabled: record.enabled };
  }
  const list = record.breakGlassUsernames;
  if (!Array.isArray(list) || list.some((name) => typeof name !== "string")) {
    throw new ApiValidationError("breakGlassUsernames must be an array of usernames");
  }
  const names = [...new Set((list as string[]).map((name) => name.trim().toLowerCase()).filter(Boolean))];
  if (names.length > MAX_BREAK_GLASS_ACCOUNTS) {
    throw new ApiValidationError(`At most ${MAX_BREAK_GLASS_ACCOUNTS} break-glass accounts are allowed`);
  }
  if (names.some((name) => name.length > MAX_USERNAME_LENGTH)) {
    throw new ApiValidationError("A break-glass username is too long");
  }
  return { enabled: record.enabled, breakGlassUsernames: names };
}

/**
 * The user ids for `names` (lowercase sign-in usernames). Every name must be
 * the username an existing account signs in with on the login page, with a
 * password, or the whole change is refused.
 */
async function resolveBreakGlassUsernames(reader: SsoReader, names: readonly string[]): Promise<number[]> {
  const ids: number[] = [];
  for (const name of names) {
    const row = await first(reader.select({ id: users.id }).from(users).where(eq(users.username, name)).limit(1));
    if (!row) {
      throw new ApiValidationError(`No account signs in with the username "${name}"`);
    }
    if (await passwordSignInUsername(reader, row.id) === null) {
      throw new ApiValidationError(`The account "${name}" cannot sign in with a password. Give it a password first.`);
    }
    ids.push(row.id);
  }
  return [...new Set(ids)];
}

export const NO_SSO_PROVIDER_MESSAGE =
  "Enforced SSO needs at least one enabled OAuth/OIDC or SAML provider. Add or enable one on the OAuth providers or SAML page first.";

async function auditSummary(previous: SsoEnforcementConfig, next: SsoEnforcementConfig, reader: SsoReader): Promise<string> {
  const names = (await describeBreakGlassAccounts(reader, next.breakGlassUserIds)).map((a) => a.username ?? `#${a.id}`);
  const breakGlass = `break-glass accounts: ${names.length > 0 ? names.join(", ") : "none"}`;
  if (next.enabled && !previous.enabled) return `Turned on enforced SSO for dashboard sign-in (${breakGlass})`;
  if (!next.enabled && previous.enabled) return `Turned off enforced SSO for dashboard sign-in (${breakGlass})`;
  return `Updated enforced SSO, ${next.enabled ? "on" : "off"} (${breakGlass})`;
}

/**
 * Changes the setting: turning enforcement on, or changing it while on, needs
 * an enabled SSO provider. Break-glass accounts are optional; the ones listed
 * must exist and be able to sign in with a password. Without a break-glass
 * administrator, the way back in during an outage of the identity provider is
 * turning enforcement off from the host (scripts/db/break-glass.ts).
 * The checks and the write share one transaction.
 */
export async function updateSsoEnforcement(input: SsoEnforcementInput, actorUserId: number): Promise<SsoEnforcementView> {
  const { previous, next } = await appDb.transaction(async (tx) => {
    const current = await readSsoEnforcement(tx);
    const breakGlassUserIds = input.breakGlassUsernames === undefined
      ? (await describeBreakGlassAccounts(tx, current.breakGlassUserIds)).map((a) => a.id)
      : await resolveBreakGlassUsernames(tx, input.breakGlassUsernames);
    const updated: SsoEnforcementConfig = { enabled: input.enabled, breakGlassUserIds };
    if (updated.enabled && (await listEnabledSsoProviders(tx)).length === 0) {
      throw new ApiValidationError(NO_SSO_PROVIDER_MESSAGE);
    }
    await writeSsoEnforcement(tx, updated);
    return { previous: current, next: updated };
  });

  await logAuditEvent({
    userId: actorUserId,
    action: "sso_enforcement_updated",
    entityType: "sso_enforcement",
    summary: await auditSummary(previous, next, appDb),
    data: {
      enabled: next.enabled,
      breakGlassUserIds: next.breakGlassUserIds,
      previous: { enabled: previous.enabled, breakGlassUserIds: previous.breakGlassUserIds },
    },
  });

  return getSsoEnforcementView();
}
