// SPDX-License-Identifier: Elastic-2.0
/**
 * Multi-tenancy: shapes shared by the server and the dashboard's client
 * components (no database access here).
 */

/** A row the provider can move between organisations, as the move dialog lists it. */
export type MovableRow = {
  id: number;
  label: string;
  detail: string | null;
  organizationId: number | null;
};

export type MovableRows = {
  proxyHosts: MovableRow[];
  certificates: MovableRow[];
  accessLists: MovableRow[];
  groups: MovableRow[];
  users: MovableRow[];
};

export const MOVABLE_KINDS = [
  { key: "proxyHosts", field: "proxyHostIds", label: "Proxy hosts" },
  { key: "certificates", field: "certificateIds", label: "Certificates" },
  { key: "accessLists", field: "accessListIds", label: "Access lists" },
  { key: "groups", field: "groupIds", label: "Groups" },
  { key: "users", field: "userIds", label: "Users" },
] as const;

/** The organisation switcher: what the dashboard shows a provider-level user. */
export type OrganizationViewOption = { value: string; label: string };
