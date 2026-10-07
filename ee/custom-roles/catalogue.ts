// SPDX-License-Identifier: Elastic-2.0
/**
 * The permission catalogue as the REST API and the role editor describe it.
 * Pure data from src/lib/permissions.ts; no database.
 */
import {
  ADMIN_LEVEL_COMBINATIONS,
  ADMIN_LEVEL_PERMISSIONS,
  PERMISSION_AREA_NAMES,
  PERMISSION_AREAS,
  UNSCOPED_ONLY_PERMISSIONS,
  type PermissionAreaInfo,
} from "@/src/lib/permissions";

export type PermissionCatalogueArea = {
  area: string;
  label: string;
  description: string;
  permissions: string[];
  scopable: boolean;
  instanceWide: boolean;
};

export type PermissionCatalogue = {
  areas: PermissionCatalogueArea[];
  adminLevel: { permissions: string[]; combinations: string[][] };
  unscopedOnly: string[];
};

export function describePermissionCatalogue(): PermissionCatalogue {
  return {
    areas: PERMISSION_AREA_NAMES.map((area) => {
      const info: PermissionAreaInfo = PERMISSION_AREAS[area];
      return {
        area,
        label: info.label,
        description: info.description,
        permissions: info.actions.map((action) => `${area}:${action}`),
        scopable: info.scopable === true,
        instanceWide: info.instanceWide === true,
      };
    }),
    adminLevel: {
      permissions: [...ADMIN_LEVEL_PERMISSIONS],
      combinations: ADMIN_LEVEL_COMBINATIONS.map((combination) => [...combination]),
    },
    unscopedOnly: [...UNSCOPED_ONLY_PERMISSIONS],
  };
}
