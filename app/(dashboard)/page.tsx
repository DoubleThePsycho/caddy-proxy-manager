import { getSessionAccess, requireUser } from "@/src/lib/auth";
import { loadOverview } from "@/src/lib/overview";
import OverviewClient from "./OverviewClient";

export const metadata = { title: "Overview" };

/**
 * The overview: what needs attention, traffic, the busiest hosts, the nodes
 * and recent changes, each shown only to users who may read it
 * (src/lib/overview.ts), and the setup checklist while the install is fresh.
 * Any signed-in user may open it.
 */
export default async function OverviewPage({ searchParams }: { searchParams: Promise<{ range?: string | string[] }> }) {
  const session = await requireUser();
  const access = await getSessionAccess(session);
  const { range } = await searchParams;
  const data = await loadOverview(access, {
    range,
    userName: session.user.name || session.user.email || "there",
  });
  return <OverviewClient data={data} />;
}
