import { requirePermission } from "@/src/lib/auth";
import { renderUsersAndGroups } from "../users/users-and-groups";

export const metadata = { title: "Users and groups" };

/** Users and groups, opened on the Groups tab. A role with groups:read but not users:read sees that tab only. */
export default async function GroupsPage() {
  const session = await requirePermission("groups:read");
  return renderUsersAndGroups(session, "groups");
}
