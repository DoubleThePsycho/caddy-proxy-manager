import L4ProxyHostsClient from "./L4ProxyHostsClient";
import { listL4ProxyHosts } from "@/src/lib/models/l4-proxy-hosts";
import { requirePermission } from "@/src/lib/auth";
import { can, scopeTagsFor } from "@/src/lib/permissions";
import { getHostApprovalContext } from "@/ee/approvals/requests";
import { isL4SortKey, matchesL4Search, sortL4Hosts, type L4ProtocolFilter } from "./list";

const PER_PAGE = 25;

interface PageProps {
  searchParams: Promise<{ page?: string; search?: string; protocol?: string; sortBy?: string; sortDir?: string }>;
}

export default async function L4ProxyHostsPage({ searchParams }: PageProps) {
  const { access } = await requirePermission("l4_proxy_hosts:read");
  // A tag scope limits the list (and the counts) to hosts with one of the role's tags.
  const scope = scopeTagsFor(access, "l4_proxy_hosts");
  const params = await searchParams;
  const search = params.search?.trim() || undefined;
  const protocol: L4ProtocolFilter = params.protocol === "tcp" || params.protocol === "udp" ? params.protocol : "all";
  const sortBy = isL4SortKey(params.sortBy) ? params.sortBy : "createdAt";
  const sortDir = params.sortDir === "asc" || params.sortDir === "desc" ? params.sortDir : "desc";

  // L4 hosts are few (each holds a port), so the page filters, counts and
  // sorts them in memory: the protocol counts follow the search.
  const all = await listL4ProxyHosts(scope);
  const matching = search ? all.filter((host) => matchesL4Search(host, search)) : all;
  const protocolCounts = {
    all: matching.length,
    tcp: matching.filter((host) => host.protocol === "tcp").length,
    udp: matching.filter((host) => host.protocol === "udp").length,
  };
  const filtered = protocol === "all" ? matching : matching.filter((host) => host.protocol === protocol);
  const sorted = sortL4Hosts(filtered, sortBy, sortDir);
  const pageCount = Math.max(1, Math.ceil(sorted.length / PER_PAGE));
  const page = Math.min(pageCount, Math.max(1, parseInt(params.page ?? "1", 10) || 1));
  const hosts = sorted.slice((page - 1) * PER_PAGE, page * PER_PAGE);

  return (
    <L4ProxyHostsClient
      hosts={hosts}
      totalHosts={all.length}
      pagination={{ total: sorted.length, page, perPage: PER_PAGE }}
      initialSearch={search ?? ""}
      protocol={protocol}
      protocolCounts={protocolCounts}
      initialSort={{ sortBy, sortDir }}
      canWrite={can(access, "l4_proxy_hosts:write")}
      scopeTags={scope ? [...scope] : []}
      approval={await getHostApprovalContext(access)}
    />
  );
}
