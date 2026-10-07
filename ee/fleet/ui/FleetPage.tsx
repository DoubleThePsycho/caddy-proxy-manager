// SPDX-License-Identifier: Elastic-2.0
import { requirePermission } from "@/src/lib/auth";
import { can } from "@/src/lib/permissions";
import { DEFAULT_PAGE_SIZE, parsePageParam } from "@/src/lib/pagination";
import { getFleetOverview } from "@/ee/fleet/overview";
import { listRevisions } from "@/ee/fleet/revisions";
import { listRollouts } from "@/ee/fleet/rollouts";
import FleetClient, { type ServerPage } from "./FleetClient";

export const metadata = { title: "Fleet" };

type Search = { rollouts?: string | string[]; revisions?: string | string[] };

/** The requested page of a list read `DEFAULT_PAGE_SIZE` rows at a time, clamped to the last page. */
async function pageOf<T>(requested: number, load: (offset: number) => Promise<{ items: T[]; total: number }>): Promise<ServerPage<T>> {
  const first = await load((requested - 1) * DEFAULT_PAGE_SIZE);
  const page = Math.min(requested, Math.max(1, Math.ceil(first.total / DEFAULT_PAGE_SIZE)));
  if (page === requested) return { items: first.items, total: first.total, page };
  const last = await load((page - 1) * DEFAULT_PAGE_SIZE);
  return { items: last.items, total: last.total, page };
}

export default async function FleetPage({ searchParams }: { searchParams?: Promise<Search> }) {
  const { access } = await requirePermission("fleet:read");
  const search = (await searchParams) ?? {};
  // The overview carries no secrets: revisions are listed without content.
  const [overview, rolloutPage, revisionPage] = await Promise.all([
    getFleetOverview(),
    pageOf(parsePageParam(search.rollouts), async (offset) => {
      const { rollouts, total } = await listRollouts({ limit: DEFAULT_PAGE_SIZE, offset });
      return { items: rollouts, total };
    }),
    pageOf(parsePageParam(search.revisions), async (offset) => {
      const { revisions, total } = await listRevisions({ limit: DEFAULT_PAGE_SIZE, offset });
      return { items: revisions, total };
    }),
  ]);
  return (
    <FleetClient
      overview={overview}
      rolloutPage={rolloutPage}
      revisionPage={revisionPage}
      now={new Date().toISOString()}
      allowed={{ write: can(access, "fleet:write"), promote: can(access, "fleet:promote"), replicas: can(access, "fleet:replicas") }}
    />
  );
}
