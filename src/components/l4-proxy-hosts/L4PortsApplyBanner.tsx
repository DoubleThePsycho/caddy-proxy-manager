"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/button";

export type PortsDiff = {
  currentPorts: string[];
  requiredPorts: string[];
  needsApply: boolean;
};

type PortsStatus = {
  state: "idle" | "pending" | "applying" | "applied" | "failed";
  message?: string;
  appliedAt?: string;
  error?: string;
};

type PortsResponse = {
  diff: PortsDiff;
  status: PortsStatus;
  error?: string;
};

/** The hosts the banner can name when their port is waiting. */
export type L4PortHost = { name: string; listenAddress: string; protocol: string; enabled: boolean };

/** "8883:8883" → "8883/tcp", "51820:51820/udp" → "51820/udp". */
export function portLabel(mapping: string): string {
  const [ports, proto] = mapping.split("/");
  const port = ports.split(":").pop() ?? ports;
  return `${port}/${proto ?? "tcp"}`;
}

/** The docker port mapping an L4 host needs ("8883:8883", "51820:51820/udp"), or null. */
export function portMappingFor(host: Pick<L4PortHost, "listenAddress" | "protocol">): string | null {
  const match = host.listenAddress.trim().match(/:(\d+)$/);
  if (!match) return null;
  return `${match[1]}:${match[1]}${host.protocol === "udp" ? "/udp" : ""}`;
}

function joinList(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** Up to this many ports are named in the banner; more are counted, and listed on request. */
const PORTS_NAMED = 3;

/** "Port 8883/tcp is", "Ports 8883/tcp and 53/udp are", "12 ports are". */
function portsSubject(mappings: string[]): string {
  if (mappings.length > PORTS_NAMED) return `${mappings.length} ports are`;
  return `${mappings.length === 1 ? "Port" : "Ports"} ${joinList(mappings.map(portLabel))} ${mappings.length === 1 ? "is" : "are"}`;
}

/**
 * L4 ports are published on the Caddy container, which has to be recreated
 * when they change (the l4-port-manager sidecar does it). This banner shows
 * ports that are saved but not published yet and starts the publishing.
 */
export function L4PortsApplyBanner({
  refreshSignal,
  canApply = true,
  hosts = [],
  onDiff,
}: {
  refreshSignal?: number;
  /** The user may publish ports (l4_proxy_hosts:write). */
  canApply?: boolean;
  hosts?: readonly L4PortHost[];
  /** Called with the port diff after every fetch, so the table can mark waiting hosts. */
  onDiff?: (diff: PortsDiff) => void;
}) {
  const [data, setData] = useState<PortsResponse | null>(null);
  const [applying, setApplying] = useState(false);
  const [published, setPublished] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const onDiffRef = useRef(onDiff);
  useEffect(() => {
    onDiffRef.current = onDiff;
  }, [onDiff]);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/l4-ports");
      if (res.ok) {
        const body = (await res.json()) as PortsResponse;
        setData(body);
        onDiffRef.current?.(body.diff);
      }
    } catch {
      // ignore fetch errors
    }
  }, []);

  // Initial fetch on mount
  useEffect(() => {
    void fetchStatus();
  }, [fetchStatus]);

  // Re-fetch when the parent signals a mutation (create/edit/delete/toggle)
  useEffect(() => {
    if (!refreshSignal) return;
    void fetchStatus();
  }, [refreshSignal, fetchStatus]);

  // Poll while the sidecar recreates the container.
  const state = data?.status.state;
  useEffect(() => {
    if (state !== "pending" && state !== "applying") return;
    const interval = setInterval(() => void fetchStatus(), 2000);
    return () => clearInterval(interval);
  }, [state, fetchStatus]);

  const handleApply = async () => {
    setApplying(true);
    try {
      const res = await fetch("/api/l4-ports", { method: "POST" });
      if (res.ok) {
        setPublished(true);
        await fetchStatus();
      }
    } catch {
      // ignore
    } finally {
      setApplying(false);
    }
  };

  if (!data) return null;
  const { diff, status } = data;
  const busy = applying || status.state === "pending" || status.state === "applying";

  if (busy) {
    return (
      <Banner tone="info" icon={LoaderCircle} title="Publishing ports." live className="[&>svg]:animate-spin">
        The Caddy container is being recreated; traffic through Caddy pauses for a few seconds.
      </Banner>
    );
  }

  if (status.state === "failed") {
    return (
      <Banner
        tone="bad"
        title="Publishing ports failed."
        live
        actions={
          canApply && diff.needsApply ? (
            <Button variant="outline" size="sm" onClick={handleApply}>
              Try again
            </Button>
          ) : undefined
        }
      >
        {status.error ?? status.message ?? "The Caddy container could not be recreated."}
      </Banner>
    );
  }

  if (diff.needsApply) {
    const waiting = diff.requiredPorts.filter((port) => !diff.currentPorts.includes(port));
    const unused = diff.currentPorts.filter((port) => !diff.requiredPorts.includes(port));
    const ports = waiting.length > 0 ? waiting : unused;
    // Each waiting port with the hosts that use it; ports no host uses any more on their own.
    const lines = ports.map((mapping) => {
      const names = hosts.filter((host) => host.enabled && portMappingFor(host) === mapping).map((host) => host.name);
      return names.length > 0 ? `${portLabel(mapping)}: ${joinList(names)}` : portLabel(mapping);
    });
    return (
      <Banner
        tone="warn"
        // The port list needs block layout (a list cannot sit in the inline paragraph).
        layout={ports.length > PORTS_NAMED && listOpen ? "stacked" : "inline"}
        title={`${portsSubject(ports)} ${waiting.length > 0 ? "not published yet" : "still published"}.`}
        actions={
          ports.length > PORTS_NAMED || canApply ? (
            <>
              {ports.length > PORTS_NAMED && (
                <Button variant="ghost" size="sm" aria-expanded={listOpen} onClick={() => setListOpen((open) => !open)}>
                  {listOpen ? "Hide ports" : "Show ports"}
                </Button>
              )}
              {canApply && (
                <Button variant="outline" size="sm" onClick={handleApply}>
                  Publish ports now
                </Button>
              )}
            </>
          ) : undefined
        }
      >
        Publishing recreates the Caddy container: traffic through Caddy pauses for a few seconds.
        {ports.length > PORTS_NAMED && listOpen && (
          <ul className="mt-1.5 mb-0 list-none p-0 num text-xs">
            {lines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        )}
      </Banner>
    );
  }

  if (published && status.state === "applied") {
    const listening = diff.requiredPorts.map(portLabel);
    return (
      <Banner tone="ok" title="Ports published." live onDismiss={() => setPublished(false)}>
        {listening.length === 0
          ? "Caddy publishes no L4 ports now."
          : listening.length > PORTS_NAMED
            ? `Caddy now listens on ${listening.length} L4 ports.`
            : `Caddy now listens on ${joinList(listening)}.`}
      </Banner>
    );
  }

  return null;
}
