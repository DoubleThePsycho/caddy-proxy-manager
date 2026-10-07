// SPDX-License-Identifier: Elastic-2.0
/**
 * SCIM provisioning: shared types and constants. Safe to import from client
 * components (no server-only dependencies).
 */

/** Path of the SCIM service root under the dashboard's base URL. */
export const SCIM_BASE_PATH = "/scim/v2";

export const SCIM_DELETE_MODES = ["disable", "delete"] as const;
export type ScimDeleteMode = (typeof SCIM_DELETE_MODES)[number];

/** Built-in roles a SCIM user may get when no group-to-role mapping applies. */
export const SCIM_DEFAULT_ROLES = ["user", "viewer"] as const;
export type ScimDefaultRole = (typeof SCIM_DEFAULT_ROLES)[number];

export type ScimSettings = {
  /** Whether the /scim/v2 endpoints accept requests. */
  enabled: boolean;
  /**
   * The OAuth/OIDC provider (its id) or SAML provider ("saml:<id>", ee/saml)
   * SCIM users sign in with. Their first sign-in through it links the
   * identity to the provisioned account (see ee/scim/binding.ts); null: no
   * provider, no such linking.
   */
  providerId: string | null;
  /** What a SCIM DELETE does: disable the account (default) or delete it. */
  deleteMode: ScimDeleteMode;
  /** Role of new SCIM users, and of SCIM users no mapping applies to while roles are managed. */
  defaultRole: ScimDefaultRole;
  /** Apply the group-to-role mappings to SCIM users on every SCIM change (and when mappings change). */
  manageRoles: boolean;
  /** Linking needs the sign-in's email_verified claim to be true (unless externalIdClaim is set). */
  requireVerifiedEmail: boolean;
  /** When set, linking needs this sign-in claim to equal the user's SCIM externalId exactly. */
  externalIdClaim: string | null;
};

export const DEFAULT_SCIM_SETTINGS: ScimSettings = Object.freeze({
  enabled: false,
  providerId: null,
  deleteMode: "disable",
  defaultRole: "user",
  manageRoles: false,
  requireVerifiedEmail: true,
  externalIdClaim: null,
}) as ScimSettings;

export type ScimProviderOption = { id: string; name: string; enabled: boolean; autoLink: boolean };

export type ScimSettingsView = ScimSettings & {
  /** The SCIM base URL to give the identity provider. */
  endpointUrl: string;
  providers: ScimProviderOption[];
  counts: { users: number; groups: number; tokens: number; mappings: number };
};

export type ScimTokenView = {
  id: number;
  name: string;
  /** The first characters of the token, to tell tokens apart. */
  prefix: string;
  createdBy: number | null;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  expired: boolean;
};

export type ScimRoleMappingView = {
  id: number;
  groupId: number;
  groupName: string;
  role: "admin" | "user" | "viewer";
  customRoleId: number | null;
  customRoleName: string | null;
  priority: number;
  createdAt: string;
  updatedAt: string;
};

export type ScimManagedUserView = {
  userId: number;
  email: string;
  name: string | null;
  status: string;
  role: string;
  customRoleId: number | null;
  userName: string;
  externalId: string | null;
  origin: "scim" | "adopted";
  /** The identity provider deleted the user (delete mode "disable"). */
  deletedAt: string | null;
  /** When the first SSO sign-in linked the identity. */
  linkedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ScimManagedGroupView = {
  groupId: number;
  name: string;
  externalId: string | null;
  origin: "scim" | "adopted";
  /** Members that SCIM manages (other members of an adopted group are left alone). */
  scimMemberCount: number;
  memberCount: number;
  createdAt: string;
  updatedAt: string;
};
