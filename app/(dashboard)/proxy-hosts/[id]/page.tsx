import { notFound } from "next/navigation";
import { requirePermission } from "@/src/lib/auth";
import { can, tenantOf } from "@/src/lib/permissions";
import { findProxyHostInScope } from "@/src/lib/access-scope";
import { getAccessList } from "@/src/lib/models/access-lists";
import { loadHostDetail } from "@/src/lib/proxy-host-detail";
import { dashboardOrganizationFilter } from "@/ee/multi-tenancy/view";
import { matchesOrganizationFilter } from "@/ee/multi-tenancy/scope";
import HostDetailClient from "./HostDetailClient";
import { parseRowId } from "@/src/lib/row-ids";

export const metadata = { title: "Proxy host" };

export default async function ProxyHostPage({ params }: { params: Promise<{ id: string }> }) {
  const { access } = await requirePermission("proxy_hosts:read");
  const { id } = await params;
  // 404 for a host outside the role's tag scope or the organisation in view, as for a missing one.
  const hostId = parseRowId(id);
  const host = hostId === null ? null : await findProxyHostInScope(access, hostId);
  const organizationId = await dashboardOrganizationFilter(access);
  if (!host || !matchesOrganizationFilter(host.organizationId, organizationId)) notFound();

  // The host's own access list is named, as in the host form's picker.
  const accessList = host.accessListId !== null ? await getAccessList(host.accessListId).catch(() => null) : null;
  const detail = await loadHostDetail(access, host, {
    organizationId,
    accessListNames: accessList ? new Map([[accessList.id, accessList.name]]) : undefined,
  });

  return (
    <HostDetailClient
      host={{ id: host.id, name: host.name, domains: host.domains, enabled: host.enabled, tags: host.tags }}
      detail={detail}
      can={{
        write: can(access, "proxy_hosts:write"),
        analytics: can(access, "analytics:read"),
        alerts: can(access, "alerts:read") && tenantOf(access) === null,
        certificates: can(access, "certificates:read"),
        auditLog: can(access, "audit_log:read"),
        approvals: can(access, "approvals:read"),
        security: can(access, "waf:read"),
      }}
    />
  );
}
