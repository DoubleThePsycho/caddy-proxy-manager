import { requireUser, getCurrentSessionId, getSessionAccess } from "@/src/lib/auth";
import { getPasswordSignInStatus, getUserById, getUserPasswordHash, listUserOAuthProviders } from "@/src/lib/models/user";
import { getProviderDisplayList } from "@/src/lib/models/oauth-providers";
import { listApiTokens, MAX_TOKENS_PER_USER } from "@/src/lib/models/api-tokens";
import { describeUserSessions } from "@/src/lib/models/sessions";
import { getMfaStatus } from "@/src/lib/mfa";
import { listPasskeys, passkeyRegistrationBlocker } from "@/src/lib/passkeys";
import { listHeldPermissions } from "@/src/lib/permissions";
import { oauthProviderHosts } from "@/src/lib/login-providers";
import ProfileClient from "./ProfileClient";
import { appDb } from "@/src/lib/db";
import { readCustomRole } from "@/ee/custom-roles/store";
import { readSsoEnforcement } from "@/ee/sso/enforcement-store";
import { redirect } from "next/navigation";

const ROLE_LABELS: Record<string, string> = {
  admin: "Administrator",
  user: "User",
  viewer: "Viewer",
};

export default async function ProfilePage() {
  const session = await requireUser();
  const userId = Number(session.user.id);

  const user = await getUserById(userId);
  if (!user) {
    redirect("/login");
  }

  // OAuth connection state comes from the authoritative accounts table — the
  // informational users.provider/subject columns are only a projection (#261).
  const linkedProviders = await listUserOAuthProviders(userId);

  const currentSessionId = await getCurrentSessionId();
  const [enabledProviders, apiTokens, sessions, passwordHash, passwordSignIn] = await Promise.all([
    getProviderDisplayList(),
    listApiTokens(userId),
    describeUserSessions(userId, currentSessionId),
    getUserPasswordHash(user),
    getPasswordSignInStatus(userId),
  ]);

  const sso = await readSsoEnforcement(appDb);
  let providerHosts = new Map<string, string>();
  try {
    providerHosts = await oauthProviderHosts();
  } catch {
    // Only shown next to linked providers.
  }
  const customRole = user.customRoleId != null ? await readCustomRole(appDb, user.customRoleId) : null;

  // Only what the page needs crosses into the client bundle — never the hash.
  const userData = {
    id: user.id,
    email: user.email,
    name: user.name,
    provider: user.provider,
    subject: user.subject,
    hasPassword: !!passwordHash,
    // Same check the unlink-oauth route makes, so the unlink button only shows
    // when the login page would still let the user in; otherwise the reason.
    signInUsername: passwordSignIn.username,
    passwordSignInBlocker: passwordSignIn.blocker,
    // A custom role shows by name; one that no longer exists is the viewer role.
    role: user.customRoleId != null ? customRole?.name ?? "viewer" : user.role,
    roleLabel: user.customRoleId != null ? customRole?.name ?? "Viewer" : ROLE_LABELS[user.role] ?? user.role,
    avatarUrl: user.avatarUrl,
  };

  return (
    <ProfileClient
      user={userData}
      linkedProviders={linkedProviders}
      enabledProviders={enabledProviders.map((provider) => ({ ...provider, host: providerHosts.get(provider.id) ?? null }))}
      apiTokens={apiTokens}
      maxApiTokens={MAX_TOKENS_PER_USER}
      sessions={sessions}
      // Counts and flags only: the authenticator secret and backup codes never leave the server.
      mfa={await getMfaStatus(userId)}
      passkeys={await listPasskeys(userId)}
      passkeyBlocker={await passkeyRegistrationBlocker(userId)}
      // Enforced SSO (ee/sso): whether this account's password still works.
      sso={{ enforced: sso.enabled, breakGlass: sso.breakGlassUserIds.includes(userId) }}
      // The permissions a token can be limited to: those the user's role holds.
      heldPermissions={listHeldPermissions(await getSessionAccess(session))}
    />
  );
}
