"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { MoreHorizontal, Network, Plus, Search } from "lucide-react";
import type { L4ProxyHost } from "@/src/lib/models/l4-proxy-hosts";
import { toggleL4ProxyHostAction } from "./actions";
import { toast } from "sonner";
import type { HostApprovalContext } from "@/ee/approvals/types";
import { useBranding } from "@/ee/white-label/ui/BrandingProvider";
import { PageHeader } from "@/components/ui/PageHeader";
import { DataTable } from "@/components/ui/DataTable";
import { EmptyState } from "@/components/ui/EmptyState";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { StatusDot, type StatusTone } from "@/components/ui/StatusDot";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { CreateL4HostDialog, EditL4HostDialog, DeleteL4HostDialog } from "@/components/l4-proxy-hosts/L4HostDialogs";
import { L4PortsApplyBanner, portMappingFor, type PortsDiff } from "@/components/l4-proxy-hosts/L4PortsApplyBanner";
import { HostTagBadges } from "@/components/hosts/HostTags";
import { matcherText, proxyProtocolText, tlsView, type L4ProtocolFilter } from "./list";
import { L4HostDetail } from "./L4HostDetail";

type Props = {
  hosts: L4ProxyHost[];
  /** Every L4 host the user may see, before filters. */
  totalHosts: number;
  pagination: { total: number; page: number; perPage: number };
  initialSearch: string;
  protocol: L4ProtocolFilter;
  protocolCounts: Record<L4ProtocolFilter, number>;
  initialSort?: { sortBy: string; sortDir: "asc" | "desc" };
  /** The user may create, change and delete hosts (l4_proxy_hosts:write); true when omitted. */
  canWrite?: boolean;
  /** The tags the user's role is limited to, if any. */
  scopeTags?: string[];
  /** Change approval policies (ee/approvals), so the dialogs can say a host is protected. */
  approval?: HostApprovalContext | null;
};

export type L4HostStatus = { tone: StatusTone; label: string };

/** Disabled, waiting for its port to be published, or active. */
export function l4HostStatus(host: L4ProxyHost, portsDiff: PortsDiff | null): L4HostStatus {
  if (!host.enabled) return { tone: "off", label: "Disabled" };
  const mapping = portMappingFor(host);
  if (portsDiff && mapping && portsDiff.requiredPorts.includes(mapping) && !portsDiff.currentPorts.includes(mapping)) {
    return { tone: "warn", label: "Port not published" };
  }
  return { tone: "ok", label: "Active" };
}

function ProtocolChip({ protocol }: { protocol: string }) {
  return (
    <span className="num rounded bg-raise px-[5px] text-[11px] leading-[18px] text-muted-foreground">{protocol.toUpperCase()}</span>
  );
}

export default function L4ProxyHostsClient({
  hosts,
  totalHosts,
  pagination,
  initialSearch,
  protocol,
  protocolCounts,
  initialSort,
  canWrite = true,
  scopeTags = [],
  approval = null,
}: Props) {
  const { productName } = useBranding();
  const [createOpen, setCreateOpen] = useState(false);
  const [duplicateHost, setDuplicateHost] = useState<L4ProxyHost | null>(null);
  const [editHost, setEditHost] = useState<L4ProxyHost | null>(null);
  const [deleteHost, setDeleteHost] = useState<L4ProxyHost | null>(null);
  // Counter forces CreateL4HostDialog to remount on each open, resetting useFormState
  const [dialogKey, setDialogKey] = useState(0);
  const [searchTerm, setSearchTerm] = useState(initialSearch);
  const [bannerRefresh, setBannerRefresh] = useState(0);
  const [portsDiff, setPortsDiff] = useState<PortsDiff | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(hosts[0]?.id ?? null);

  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const signalBannerRefresh = () => setBannerRefresh(n => n + 1);

  useEffect(() => { setSearchTerm(initialSearch); }, [initialSearch]);

  const selected = hosts.find((host) => host.id === selectedId) ?? hosts[0] ?? null;

  function pushParams(update: (params: URLSearchParams) => void) {
    const params = new URLSearchParams(searchParams.toString());
    update(params);
    params.set("page", "1");
    router.push(`${pathname}?${params.toString()}`);
  }

  function handleSearchChange(value: string) {
    setSearchTerm(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      pushParams((params) => {
        if (value.trim()) params.set("search", value.trim());
        else params.delete("search");
      });
    }, 400);
  }

  function handleProtocolChange(value: L4ProtocolFilter) {
    pushParams((params) => {
      if (value === "all") params.delete("protocol");
      else params.set("protocol", value);
    });
  }

  function clearFilters() {
    setSearchTerm("");
    pushParams((params) => {
      params.delete("search");
      params.delete("protocol");
    });
  }

  const handleToggleEnabled = async (id: number, enabled: boolean) => {
    const result = await toggleL4ProxyHostAction(id, enabled);
    signalBannerRefresh();
    // A protected host is not toggled at once: the change waits for approval (ee/approvals).
    if (result.status === "error") toast.error(result.message ?? "Failed to toggle L4 proxy host");
    else if (result.changeRequest) toast.info(result.message ?? "Submitted for approval", { duration: 10000 });
    router.refresh();
  };

  const openCreate = () => { setDuplicateHost(null); setDialogKey(k => k + 1); setCreateOpen(true); };
  const openDuplicate = (host: L4ProxyHost) => { setDuplicateHost(host); setDialogKey(k => k + 1); setCreateOpen(true); };

  const actionsMenu = (host: L4ProxyHost) => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={`More actions for ${host.name}`}>
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => setEditHost(host)}>Edit</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => openDuplicate(host)}>Duplicate</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem className="text-bad focus:text-bad" onSelect={() => setDeleteHost(host)}>
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const nameButton = (host: L4ProxyHost) => (
    <button
      type="button"
      onClick={() => setSelectedId(host.id)}
      aria-pressed={selected?.id === host.id}
      className="text-left font-semibold text-foreground underline-offset-4 hover:underline"
    >
      {host.name}
    </button>
  );

  const columns = [
    {
      id: "name",
      label: "Name",
      sortKey: "name",
      render: (host: L4ProxyHost) => (
        <span className="flex min-w-0 flex-col gap-px">
          {nameButton(host)}
          <span className="text-xs text-soft">{matcherText(host)}</span>
          <HostTagBadges tags={host.tags} />
        </span>
      ),
    },
    {
      id: "listen",
      label: "Listen",
      sortKey: "listenAddress",
      render: (host: L4ProxyHost) => (
        <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
          <span className="num">{host.listenAddress}</span>
          <ProtocolChip protocol={host.protocol} />
        </span>
      ),
    },
    {
      id: "upstreams",
      label: "Upstream",
      sortKey: "upstreams",
      render: (host: L4ProxyHost) => (
        <span className="num whitespace-nowrap">
          {host.upstreams[0]}
          {host.upstreams.length > 1 && <span className="ml-1 text-soft">+{host.upstreams.length - 1}</span>}
        </span>
      ),
    },
    {
      id: "tls",
      label: "TLS",
      render: (host: L4ProxyHost) => {
        const tls = tlsView(host);
        return (
          <span className="flex flex-col">
            <span className={cn(tls.muted && "text-soft")}>{tls.label}</span>
            {tls.detail && <span className={cn("text-xs text-soft", tls.label === "Terminate" && "num")}>{tls.detail}</span>}
          </span>
        );
      },
    },
    {
      id: "proxyProtocol",
      label: "PROXY protocol",
      render: (host: L4ProxyHost) => {
        const text = proxyProtocolText(host);
        return <span className={cn(text === "Off" && "text-soft")}>{text}</span>;
      },
    },
    {
      id: "status",
      label: "Status",
      sortKey: "enabled",
      render: (host: L4ProxyHost) => {
        const status = l4HostStatus(host, portsDiff);
        return <StatusDot tone={status.tone} label={status.label} className="whitespace-nowrap" />;
      },
    },
    {
      id: "actions",
      label: "",
      align: "right" as const,
      width: 96,
      render: (host: L4ProxyHost) => canWrite && (
        <div className="flex items-center justify-end gap-2">
          <Switch
            checked={host.enabled}
            aria-label={`${host.enabled ? "Disable" : "Enable"} ${host.name}`}
            onCheckedChange={(checked) => handleToggleEnabled(host.id, checked)}
          />
          {actionsMenu(host)}
        </div>
      ),
    },
  ];

  const mobileCard = (host: L4ProxyHost) => {
    const status = l4HostStatus(host, portsDiff);
    return (
      <div
        className={cn(
          "flex items-start justify-between gap-3 rounded-xl border border-line bg-panel p-4",
          selected?.id === host.id && "border-brand bg-brand-tint"
        )}
      >
        <div className="flex min-w-0 flex-col gap-1">
          <span className="flex flex-wrap items-center gap-2">
            {nameButton(host)}
            <ProtocolChip protocol={host.protocol} />
          </span>
          <span className="num truncate text-xs text-muted-foreground">
            {host.listenAddress} → {host.upstreams[0]}
            {host.upstreams.length > 1 ? ` +${host.upstreams.length - 1}` : ""}
          </span>
          <HostTagBadges tags={host.tags} />
          <StatusDot tone={status.tone} label={status.label} className="mt-1" />
        </div>
        {canWrite && (
          <div className="flex shrink-0 items-center gap-1">
            <Switch
              checked={host.enabled}
              aria-label={`${host.enabled ? "Disable" : "Enable"} ${host.name}`}
              onCheckedChange={(checked) => handleToggleEnabled(host.id, checked)}
            />
            {actionsMenu(host)}
          </div>
        )}
      </div>
    );
  };

  const filtering = Boolean(initialSearch) || protocol !== "all";

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <PageHeader
        className="mb-0"
        breadcrumb={["Traffic", "L4 hosts"]}
        title="L4 hosts"
        count={totalHosts}
        description={`TCP and UDP proxies for traffic that is not HTTP. ${productName} publishes their ports on the Caddy container.`}
        actions={
          canWrite ? (
            <Button onClick={openCreate}>
              <Plus />
              New L4 host
            </Button>
          ) : undefined
        }
      />

      <L4PortsApplyBanner refreshSignal={bannerRefresh} canApply={canWrite} hosts={hosts} onDiff={setPortsDiff} />

      {totalHosts === 0 ? (
        <section aria-label="L4 hosts" className="rounded-2xl border border-line bg-panel">
          <EmptyState
            icon={Network}
            title="No L4 hosts yet"
            description="An L4 host forwards TCP or UDP traffic on a port of its own, for protocols that are not HTTP: SSH, mail, DNS over TLS, WireGuard."
            action={
              canWrite ? (
                <Button onClick={openCreate}>
                  <Plus />
                  New L4 host
                </Button>
              ) : undefined
            }
          />
        </section>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2.5">
            <label className="flex h-[38px] min-w-0 flex-[1_1_280px] items-center gap-2 rounded-[10px] border border-line bg-panel px-3 text-soft focus-within:border-brand">
              <Search aria-hidden="true" className="h-4 w-4 shrink-0" />
              <span className="sr-only">Filter L4 hosts</span>
              <input
                type="search"
                value={searchTerm}
                onChange={(e) => handleSearchChange(e.target.value)}
                placeholder="Name, port or upstream"
                className="h-full min-w-0 flex-1 border-0 bg-transparent text-sm text-foreground outline-none placeholder:text-soft"
              />
            </label>
            <SegmentedControl<L4ProtocolFilter>
              label="Protocol"
              value={protocol}
              onChange={handleProtocolChange}
              options={[
                { value: "all", label: <>All <span className="num text-muted-foreground">{protocolCounts.all}</span></> },
                { value: "tcp", label: <>TCP <span className="num text-muted-foreground">{protocolCounts.tcp}</span></> },
                { value: "udp", label: <>UDP <span className="num text-muted-foreground">{protocolCounts.udp}</span></> },
              ]}
            />
          </div>

          <section aria-label="L4 hosts" className="min-w-0">
            <DataTable
              columns={columns}
              data={hosts}
              keyField="id"
              emptyMessage="No L4 host matches these filters."
              pagination={pagination}
              sort={initialSort}
              mobileCard={mobileCard}
              rowClassName={(host) =>
                cn(selected?.id === host.id && "bg-brand-tint hover:bg-brand-tint", !host.enabled && "text-muted-foreground")
              }
            />
            {hosts.length === 0 && filtering && (
              <div className="mt-3 flex justify-center">
                <Button variant="secondary" size="sm" onClick={clearFilters}>
                  Clear filters
                </Button>
              </div>
            )}
          </section>

          {selected && (
            <L4HostDetail
              host={selected}
              status={l4HostStatus(selected, portsDiff)}
              canWrite={canWrite}
              onToggle={() => handleToggleEnabled(selected.id, !selected.enabled)}
              onDuplicate={() => openDuplicate(selected)}
              onEdit={() => setEditHost(selected)}
            />
          )}
        </>
      )}

      <CreateL4HostDialog
        key={dialogKey}
        open={createOpen}
        onClose={() => { setCreateOpen(false); setTimeout(() => setDuplicateHost(null), 200); signalBannerRefresh(); router.refresh(); }}
        initialData={duplicateHost}
        scopeTags={scopeTags}
        approval={approval}
      />

      {editHost && (
        <EditL4HostDialog
          open={!!editHost}
          host={editHost}
          onClose={() => { setEditHost(null); signalBannerRefresh(); router.refresh(); }}
          scopeTags={scopeTags}
          approval={approval}
        />
      )}

      {deleteHost && (
        <DeleteL4HostDialog
          open={!!deleteHost}
          host={deleteHost}
          onClose={() => { setDeleteHost(null); signalBannerRefresh(); router.refresh(); }}
          approval={approval}
        />
      )}
    </div>
  );
}
