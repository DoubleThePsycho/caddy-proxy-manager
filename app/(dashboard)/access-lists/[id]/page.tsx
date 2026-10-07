import { notFound } from "next/navigation";
import { loadAccessListOverview } from "@/src/lib/access-list-overview";
import { getTrustedProxiesSettings } from "@/src/lib/settings";
import { requirePermission } from "@/src/lib/auth";
import { can } from "@/src/lib/permissions";
import { parseRowId } from "@/src/lib/row-ids";
import { AccessListEditor } from "../AccessListEditor";

export const metadata = { title: "Access list" };

type PageProps = { params: Promise<{ id: string }> };

/** One access list. */
export default async function AccessListPage({ params }: PageProps) {
  const { access } = await requirePermission("access_lists:read");
  const { id } = await params;
  const listId = parseRowId(id);
  if (listId === null) notFound();
  const [overview, trustedProxies] = await Promise.all([loadAccessListOverview(access), getTrustedProxiesSettings()]);
  const list = overview.lists.find((item) => item.id === listId);
  if (!list) notFound();

  return (
    <AccessListEditor
      list={list}
      usage={overview.usage[list.id] ?? []}
      listStats={overview.stats.lists[list.id] ?? null}
      statsAvailable={overview.stats.available}
      canWrite={can(access, "access_lists:write")}
      trustedProxiesConfigured={(trustedProxies?.ranges ?? []).some((range) => range.trim().length > 0)}
    />
  );
}
