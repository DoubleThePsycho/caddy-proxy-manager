// SPDX-License-Identifier: Elastic-2.0
import { requirePermission } from "@/src/lib/auth";
import { can } from "@/src/lib/permissions";
import { appDb } from "@/src/lib/db";
import { EDITION_LABELS, FEATURE_INFO } from "@/ee/licensing/features";
import { isFeatureConfigurable } from "@/ee/licensing/store";
import { isSsoEnforced } from "@/ee/sso/sign-in";
import { LDAP_FEATURE } from "@/ee/ldap/constants";
import { listDirectories } from "@/ee/ldap/directories";
import LdapClient from "@/ee/ldap/ui/LdapClient";

export const metadata = { title: "LDAP directories" };

export default async function LdapPage() {
  const session = await requirePermission("ldap:read");
  return (
    <LdapClient
      directories={await listDirectories()}
      configurable={await isFeatureConfigurable(LDAP_FEATURE)}
      canWrite={can(session.access, "ldap:write")}
      ssoEnforced={await isSsoEnforced(appDb)}
      editionLabel={EDITION_LABELS[FEATURE_INFO[LDAP_FEATURE].edition]}
      canReadSignIn={can(session.access, "sso:read")}
    />
  );
}
