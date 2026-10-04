import { requirePermission } from "@/src/lib/auth";
import { can } from "@/src/lib/permissions";
import { getSignInOverview } from "@/src/lib/sign-in-overview";
import { saveSsoEnforcementAction } from "@/ee/sso/ui/actions";
import SignInClient from "./SignInClient";

export const metadata = { title: "Sign-in and directories" };

/**
 * Sign-in and directories: enforced SSO, what the login page offers, and one
 * card per place people sign in from. LDAP directories need ldap:read and
 * SCIM scim:read (the overview leaves them out otherwise); each card links to
 * the page that configures it.
 */
export default async function SignInPage() {
  const { access } = await requirePermission("sso:read");
  const overview = await getSignInOverview(access);
  return (
    <SignInClient
      overview={overview}
      can={{
        writeSso: can(access, "sso:write"),
        writeLdap: can(access, "ldap:write"),
        readSettings: can(access, "settings:read"),
        readUsers: can(access, "users:read") || can(access, "groups:read"),
        readAuditLog: can(access, "audit_log:read"),
        readScim: can(access, "scim:read"),
        readLdap: can(access, "ldap:read"),
      }}
      turnOffEnforcement={saveSsoEnforcementAction}
    />
  );
}
