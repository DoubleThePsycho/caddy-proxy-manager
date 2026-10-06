/**
 * How the Users and groups page words an account: role, sources, second
 * factor, last sign-in and status. Pure functions, safe for the client.
 */
import type { AccountSource, UserOverviewEntry } from "@/src/lib/users-overview";

export type CustomRoleOption = {
  id: number;
  name: string;
  adminLevel: boolean;
  permissionCount: number;
  scopeTags: string[];
};

export const SOURCE_LABELS: Record<AccountSource["kind"], string> = {
  local: "Local",
  oidc: "OIDC",
  saml: "SAML",
  ldap: "LDAP",
  scim: "SCIM",
};

const SIGN_IN_METHODS: Record<string, string> = {
  password: "with password",
  sso: "through single sign-on",
  saml: "through SAML",
  ldap: "through a directory",
  passkey: "with a passkey",
};

export function displayName(user: Pick<UserOverviewEntry, "name" | "email">): string {
  return user.name?.trim() || user.email.split("@")[0] || user.email;
}

export function initials(text: string): string {
  const words = text.replace(/[@._-]+/g, " ").trim().split(/\s+/).filter(Boolean);
  const letters = words.length >= 2 ? `${words[0][0]}${words[1][0]}` : (words[0] ?? "?").slice(0, 2);
  return letters.toUpperCase();
}

/** The role's name and a line about it. */
export function roleSummary(
  user: Pick<UserOverviewEntry, "role" | "customRoleId" | "roleManagedBy">,
  customRoles: ReadonlyMap<number, CustomRoleOption>,
  totalPermissions: number
): { label: string; detail: string } {
  if (user.customRoleId !== null) {
    const role = customRoles.get(user.customRoleId);
    if (!role) return { label: "Custom role", detail: user.roleManagedBy ?? `Custom · role ${user.customRoleId}` };
    const parts = [`Custom · ${role.permissionCount} permission${role.permissionCount === 1 ? "" : "s"}`];
    if (role.scopeTags.length > 0) parts.push(`tag ${role.scopeTags.join(", ")}`);
    return { label: role.name, detail: user.roleManagedBy ?? parts.join(" · ") };
  }
  switch (user.role) {
    case "admin":
      return { label: "Admin", detail: user.roleManagedBy ?? `Built-in · all ${totalPermissions} permissions` };
    case "user":
      return { label: "User", detail: user.roleManagedBy ?? "Built-in · own profile and tokens" };
    default:
      return { label: "Viewer", detail: user.roleManagedBy ?? "Built-in · own profile and tokens" };
  }
}

/** The line under the source tags. */
export function sourceDetail(sources: readonly AccountSource[]): string {
  if (sources.length === 0) return "No password and no identity provider";
  const local = sources.some((source) => source.kind === "local");
  const others = sources.filter((source) => source.kind !== "local" && source.kind !== "scim").map((source) => source.label);
  const scim = sources.some((source) => source.kind === "scim");
  if (local && others.length > 0) return `Password, linked to ${others.join(", ")}`;
  if (local) return scim ? "Password, provisioned by SCIM" : "Password";
  if (others.length > 0) return scim ? `Provisioned by SCIM, signs in with ${others.join(", ")}` : others.join(", ");
  return "Provisioned by SCIM, not linked yet";
}

export type FactorSummary = { label: string; detail: string | null; tone: "normal" | "muted" | "bad" | "warn" };

/** What the Second factor column says. `date` formats the deadline. */
export function secondFactorSummary(
  user: Pick<UserOverviewEntry, "secondFactor" | "administrator" | "sources">,
  date: (value: string) => string
): FactorSummary {
  const factor = user.secondFactor;
  switch (factor.state) {
    case "authenticator_app":
      return {
        label: "Authenticator app",
        detail: factor.passkeys > 0 ? `Also ${factor.passkeys} passkey${factor.passkeys === 1 ? "" : "s"}` : null,
        tone: "normal",
      };
    case "passkey":
      return { label: factor.passkeys === 1 ? "Passkey" : `${factor.passkeys} passkeys`, detail: null, tone: "normal" };
    case "identity_provider": {
      const provider = user.sources.find((source) => source.kind === "oidc" || source.kind === "saml");
      return { label: `At ${provider?.label ?? "the identity provider"}`, detail: "Not asked again here", tone: "muted" };
    }
    case "not_needed":
      return { label: "Not needed", detail: "Cannot sign in to the dashboard", tone: "muted" };
    default: {
      const detail =
        factor.gate === "required" && factor.deadline ? `Overdue since ${date(factor.deadline)}`
          : factor.gate === "prompt" && factor.deadline ? `Required by ${date(factor.deadline)}`
            : factor.required ? "Required by the MFA policy"
              : "Signs in with a password only";
      return { label: "None", detail, tone: user.administrator || factor.gate === "required" ? "bad" : factor.gate === "prompt" ? "warn" : "muted" };
    }
  }
}

export function signInMethodLabel(method: string | null): string | null {
  return method ? SIGN_IN_METHODS[method] ?? null : null;
}

export type StatusSummary = { kind: "active" | "invited" | "disabled"; label: string };

export function statusOf(user: Pick<UserOverviewEntry, "status" | "invited">): StatusSummary {
  if (user.status !== "active") return { kind: "disabled", label: "Disabled" };
  if (user.invited) return { kind: "invited", label: "Invited" };
  return { kind: "active", label: "Active" };
}

/** The text a search looks in. */
export function searchText(user: UserOverviewEntry, role: { label: string }): string {
  return [
    user.name,
    user.email,
    user.username,
    role.label,
    ...user.sources.map((source) => `${SOURCE_LABELS[source.kind]} ${source.label}`),
    statusOf(user).label,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}
