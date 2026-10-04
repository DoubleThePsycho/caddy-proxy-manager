import { requirePermission } from "@/src/lib/auth";
import { findProxyHostInScope } from "@/src/lib/access-scope";
import { HostEditor } from "@/src/components/proxy-hosts/editor/HostEditor";
import { loadHostEditorData } from "../editor-data";
import { parseRowId } from "@/src/lib/row-ids";

export const metadata = { title: "New proxy host" };

type PageProps = { searchParams: Promise<{ domain?: string; from?: string }> };

/** A domain from ?domain= (the command palette's "Create a proxy host"), or null when it is not one. */
function initialDomain(raw: string | undefined): string | null {
  const value = raw?.trim().toLowerCase().replace(/\.$/, "") ?? "";
  return value && value.length <= 253 && /^[a-z0-9*.:\-[\]]+$/.test(value) ? value : null;
}

/** The host editor for a new host; ?from=<id> starts from a copy of that host. */
export default async function NewProxyHostPage({ searchParams }: PageProps) {
  const { access } = await requirePermission("proxy_hosts:write");
  const { domain, from } = await searchParams;
  const templateId = parseRowId(from);
  // A host outside the role's scope is not copied (as if it did not exist).
  const template = templateId ? await findProxyHostInScope(access, templateId) : null;
  const data = await loadHostEditorData(access, { host: null, template, initialDomain: initialDomain(domain) });
  return <HostEditor data={data} />;
}
