// SPDX-License-Identifier: Elastic-2.0
/**
 * Multi-tenancy: the organisation the dashboard shows a provider-level user
 * (the organisation switcher). It is a view, kept in a cookie, and never a
 * security boundary: organisation users always see their own organisation
 * (organizationFilterFor), and provider-level users may see every row anyway.
 *
 * The cookie holds "all" (or nothing), "provider" for provider-level rows only,
 * or an organisation id.
 */
import { appDb } from "@/src/lib/db";
import { can, tenantOf, type Access } from "@/src/lib/permissions";
import { countOrganizations, listOrganizationRows, readOrganization } from "./store";
import { organizationFilterFor, type OrganizationFilter } from "./scope";
import { parseRowId } from "@/src/lib/row-ids";

export const ORGANIZATION_VIEW_COOKIE = "organization_view";

/** Parses the cookie value; anything unknown is "all". */
export function parseOrganizationView(value: string | null | undefined): OrganizationFilter {
  const raw = (value ?? "").trim();
  if (raw === "provider") return null;
  return parseRowId(raw) ?? undefined;
}

/** The cookie value for a view. */
export function formatOrganizationView(view: OrganizationFilter): string {
  return view === undefined ? "all" : view === null ? "provider" : String(view);
}

/**
 * The organisation filter the dashboard's lists use for `access`: an
 * organisation user's own organisation, or the provider-level user's chosen
 * view (only while organisations exist and the user can read them).
 */
export async function dashboardOrganizationFilter(access: Access): Promise<OrganizationFilter> {
  if (tenantOf(access) !== null) return tenantOf(access);
  return organizationFilterFor(access, await readOrganizationView(access));
}

/** The provider-level user's chosen view; undefined (every row) when there is none. */
export async function readOrganizationView(access: Access): Promise<OrganizationFilter> {
  if (tenantOf(access) !== null || !can(access, "organizations:read")) return undefined;
  let view: OrganizationFilter;
  try {
    const { cookies } = await import("next/headers");
    view = parseOrganizationView((await cookies()).get(ORGANIZATION_VIEW_COOKIE)?.value);
  } catch {
    return undefined;
  }
  if (view === undefined || await countOrganizations(appDb) === 0) return undefined;
  if (view !== null && !await readOrganization(appDb, view)) return undefined;
  return view;
}

/**
 * For a create in the dashboard: the organisation the provider-level user is
 * looking at, which the new row then belongs to (that needs
 * organizations:write and the license, see organizationForNewRow), or
 * undefined. Organisation users' rows always go to their own organisation.
 */
export async function dashboardCreateOrganization(access: Access): Promise<number | undefined> {
  if (tenantOf(access) !== null) return undefined;
  const view = await readOrganizationView(access);
  return typeof view === "number" ? view : undefined;
}

/**
 * What the dashboard's sidebar shows about organisations: the switcher for a
 * provider-level user who can read organisations (while any exist), or the
 * organisation an organisation user belongs to.
 */
export async function organizationNavigation(access: Access): Promise<{
  switcher: { value: string; options: { value: string; label: string }[] } | null;
  organizationName: string | null;
}> {
  const tenant = tenantOf(access);
  if (tenant !== null) {
    return { switcher: null, organizationName: (await readOrganization(appDb, tenant))?.name ?? null };
  }
  if (!can(access, "organizations:read")) return { switcher: null, organizationName: null };
  const organizations = await listOrganizationRows(appDb);
  if (organizations.length === 0) return { switcher: null, organizationName: null };
  return {
    switcher: {
      value: formatOrganizationView(await readOrganizationView(access)),
      options: [
        { value: "all", label: "All organisations" },
        { value: "provider", label: "Provider level" },
        ...organizations.map((organization) => ({ value: String(organization.id), label: organization.name })),
      ],
    },
    organizationName: null,
  };
}
