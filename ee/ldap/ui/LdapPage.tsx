// SPDX-License-Identifier: Elastic-2.0
import { requirePermission } from "@/src/lib/auth";
import { can } from "@/src/lib/permissions";
import { appDb } from "@/src/lib/db";
import { isSsoEnforced } from "@/ee/sso/sign-in";
import { listDirectories } from "@/ee/ldap/directories";
import LdapClient from "@/ee/ldap/ui/LdapClient";

export const metadata = { title: "LDAP directories" };

export default async function LdapPage() {
  const session = await requirePermission("ldap:read");
  return (
    <LdapClient
      directories={await listDirectories()}
      canWrite={can(session.access, "ldap:write")}
      ssoEnforced={await isSsoEnforced(appDb)}
      canReadSignIn={can(session.access, "sso:read")}
    />
  );
}
