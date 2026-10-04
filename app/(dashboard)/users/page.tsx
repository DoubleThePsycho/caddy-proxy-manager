import { requirePermission } from "@/src/lib/auth";
import { renderUsersAndGroups } from "./users-and-groups";
import { parseRowId } from "@/src/lib/row-ids";

export const metadata = { title: "Users and groups" };

type PageProps = { searchParams?: Promise<{ tab?: string; user?: string }> };

/**
 * Users and groups, opened on the Users tab (?tab=roles for Roles,
 * ?user=<id> with that user's panel open). /groups opens the Groups tab.
 */
export default async function UsersPage({ searchParams }: PageProps = {}) {
  const session = await requirePermission("users:read");
  const params = (await searchParams) ?? {};
  const selected = parseRowId(params.user);
  return renderUsersAndGroups(session, params.tab === "roles" ? "roles" : params.tab === "groups" ? "groups" : "users", selected);
}
