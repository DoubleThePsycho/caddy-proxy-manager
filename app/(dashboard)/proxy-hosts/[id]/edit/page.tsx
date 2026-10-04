import { notFound } from "next/navigation";
import { requirePermission } from "@/src/lib/auth";
import { findProxyHostInScope } from "@/src/lib/access-scope";
import { HostEditor } from "@/src/components/proxy-hosts/editor/HostEditor";
import { loadHostEditorData } from "../../editor-data";
import { parseRowId } from "@/src/lib/row-ids";

export const metadata = { title: "Edit proxy host" };

type PageProps = { params: Promise<{ id: string }> };

/** The host editor for an existing host; a host outside the role's scope is not found, as a missing one. */
export default async function EditProxyHostPage({ params }: PageProps) {
  const { access } = await requirePermission("proxy_hosts:write");
  const { id } = await params;
  const hostId = parseRowId(id);
  const host = hostId === null ? null : await findProxyHostInScope(access, hostId);
  if (!host) notFound();
  const data = await loadHostEditorData(access, { host, template: null, initialDomain: null });
  return <HostEditor data={data} />;
}
