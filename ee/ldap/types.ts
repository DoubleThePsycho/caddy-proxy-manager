// SPDX-License-Identifier: Elastic-2.0
import type { DirectoryHealth } from "./health";
import type { GroupMode, LdapRole } from "./constants";
import type { TransportConfig } from "./connection";

/** One entry of a directory's group-to-role mapping. */
export type GroupRoleMapping = { group: string; role: LdapRole };

/** A directory as sign-in uses it, with the service account password decrypted. Never leaves the server. */
export type DirectoryConfig = TransportConfig & {
  id: number;
  name: string;
  enabled: boolean;
  bindDn: string;
  bindPassword: string;
  userSearchBase: string;
  userSearchFilter: string;
  usernameAttribute: string;
  emailAttribute: string;
  displayNameAttribute: string;
  uniqueIdAttribute: string;
  groupMode: GroupMode;
  groupMembershipAttribute: string;
  groupSearchBase: string | null;
  groupSearchFilter: string | null;
  nestedGroups: boolean;
  groupRoleMappings: GroupRoleMapping[];
  defaultRole: "user" | "viewer";
  requiredGroup: string | null;
  provisionUsers: boolean;
  linkExistingAccounts: boolean;
  allowWhenSsoEnforced: boolean;
};

/** What the API and the dashboard show of a directory: everything but the service account password. */
export type LdapDirectoryView = Omit<DirectoryConfig, "bindPassword"> & {
  hasBindPassword: boolean;
  /** Accounts signed in through this directory (rows in `accounts`). */
  linkedAccounts: number;
  /** Settings worth a second look, for example an unencrypted connection. */
  warnings: string[];
  /** The periodic connection check (ee/ldap/health.ts); null until an enabled directory was first checked. */
  health: DirectoryHealth | null;
  createdAt: string;
  updatedAt: string;
};

/** The directory entry a sign-in found and authenticated, as read with the attributes the administrator chose. */
export type DirectoryUser = {
  dn: string;
  /** The stable unique id: the accounts.accountId of the link. */
  uniqueId: string;
  /** The username attribute, exactly as returned. */
  username: string;
  /** The e-mail attribute, exactly as returned, or null when the entry has none. */
  email: string | null;
  displayName: string | null;
  /** Group DNs as the directory returned them; null when the directory has no group lookup. */
  groups: string[] | null;
};
