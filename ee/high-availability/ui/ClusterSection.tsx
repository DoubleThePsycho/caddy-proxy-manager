// SPDX-License-Identifier: Elastic-2.0
"use client";

import { useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw, Server } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/EmptyState";
import { KpiTile } from "@/components/ui/KpiTile";
import { SectionCard } from "@/components/ui/SectionCard";
import { StatusDot, type StatusTone } from "@/components/ui/StatusDot";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { documentationUrl } from "@/src/lib/brand";
import { formatDateTimeUtc } from "@/src/lib/date-format";
import type { ClusterView, NodeReport, NodeRole, RestoreRecord } from "../cluster/types";
import PostgresReplicasSection from "./PostgresReplicasSection";

const DOCS_HREF = documentationUrl("ee/docs/high-availability.md");

export const ROLE_LABELS: Record<NodeRole, string> = {
  leader: "Leader",
  standby: "Standby",
  promoting: "Taking over",
  stopping: "Stopping",
};

const ROLE_TONES: Record<NodeRole, StatusTone> = { leader: "ok", standby: "info", promoting: "warn", stopping: "off" };

const SOURCE_LABELS: Record<NonNullable<RestoreRecord["source"]>, string> = {
  replica: "Restored from the newest replica",
  bootstrap: "Set the cluster up from this node's database",
  local: "Recovered from this node's own database",
};

/** Replication confirmed longer ago than this is shown as behind. */
const LAG_WARNING_SECONDS = 30;

function duration(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min`;
  return `${Math.floor(seconds / 3600)} h ${Math.floor((seconds % 3600) / 60)} min`;
}

function utc(value: string | null): string {
  return value ? `${formatDateTimeUtc(value)} UTC` : "Never";
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start gap-x-6 gap-y-1 border-t border-line py-3 first:border-t-0">
      <div className="min-w-0 flex-[0_1_210px] font-medium">{label}</div>
      <div className="min-w-0 flex-[1_1_320px] text-[13px] text-muted-foreground [overflow-wrap:anywhere]">{children}</div>
    </div>
  );
}

function copyLabel(node: NodeReport): ReactNode {
  if (node.role !== "standby") return <span className="text-soft">Not needed</span>;
  if (!node.follow) return <span className="text-soft">Off</span>;
  if (node.follow.error) return <StatusDot tone="warn" label={node.follow.error} />;
  return node.follow.ready ? <StatusDot tone="ok" label="Ready" /> : <StatusDot tone="info" label="Restoring" />;
}

/** The dashboard cluster on the High availability page: read-only, configured with environment variables. */
export default function ClusterSection({ view, editionLabel }: { view: ClusterView; editionLabel: string }) {
  if (view.postgres) {
    return <PostgresReplicasSection view={view.postgres} configurable={view.configurable} editionLabel={editionLabel} />;
  }
  return <LitestreamClusterSection view={view} editionLabel={editionLabel} />;
}

/** The SQLite cluster of HA phase 2 (HA_ENABLED: a leader, standbys, Litestream). */
function LitestreamClusterSection({ view, editionLabel }: { view: ClusterView; editionLabel: string }) {
  const router = useRouter();
  const [refreshing, startRefresh] = useTransition();
  const actions = (
    <>
      <Badge variant="outline">{editionLabel}</Badge>
      {view.enabled && (
        <Button variant="outline" size="sm" disabled={refreshing} onClick={() => startRefresh(() => router.refresh())}>
          <RefreshCw className={refreshing ? "animate-spin" : undefined} />
          Refresh
        </Button>
      )}
    </>
  );

  if (!view.enabled) {
    return (
      <SectionCard
        title="Dashboard cluster"
        headingLevel={2}
        actions={actions}
      >
        <EmptyState
          compact
          headingLevel={4}
          icon={Server}
          title="High availability is off on this node"
          description={
            <>
              Run two or more web containers with HA_ENABLED. It needs an active {editionLabel} license
              {view.configurable ? ", which this install has." : "."}
            </>
          }
          action={
            <Button asChild variant="outline" size="sm">
              <a href={DOCS_HREF} target="_blank" rel="noreferrer">
                Read the setup guide
              </a>
            </Button>
          }
        />
      </SectionCard>
    );
  }

  const { node, lease, replication, lastRestore, config } = view;
  const lag = replication?.lagSeconds ?? null;
  const behind = replication !== null && (replication.error !== null || lag === null || lag > LAG_WARNING_SECONDS);

  return (
    <SectionCard
      title="Dashboard cluster"
      description="One leader serves the dashboard; a standby takes over when it stops."
      descriptionPlacement="below"
      headingLevel={2}
      actions={actions}
      padded
      contentClassName="flex flex-col gap-4"
    >
      {view.error && (
        <Banner tone="bad" title="The cluster status is incomplete.">
          {view.error}
        </Banner>
      )}
      {lease?.error && (
        <Banner tone="warn" title="Redis or Valkey cannot be reached.">
          {lease.error}. The leader stops serving when it cannot renew its lease in time; the standbys keep trying.
        </Banner>
      )}
      {behind && (
        <Banner tone="warn" title="Replication is behind.">
          {replication?.error ? `${replication.error}. ` : ""}
          Changes made since {utc(replication?.lastSyncAt ?? null)} are only on this node until Litestream reaches object storage
          again. A failover now would lose them.
        </Banner>
      )}
      {lastRestore && !lastRestore.ok && (
        <Banner tone="bad" title="The last takeover attempt failed.">
          {lastRestore.error}
        </Banner>
      )}

      <div className="grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] gap-3">
        <KpiTile
          size="sm"
          label="This node"
          value={<span className="text-[16px]">{node?.id ?? "Unknown"}</span>}
          note={node ? <StatusDot tone={ROLE_TONES[node.role]} label={ROLE_LABELS[node.role]} /> : undefined}
        />
        <KpiTile
          size="sm"
          label="Leader"
          value={<span className="text-[16px]">{lease?.holder ?? "None"}</span>}
          note={lease?.epoch !== null && lease?.epoch !== undefined ? `Epoch ${lease.epoch}` : "No lease held"}
        />
        <KpiTile
          size="sm"
          label="Replication lag"
          value={lag === null ? "Unknown" : duration(lag)}
          note={replication ? `Last confirmed ${utc(replication.lastSyncAt)}` : "Not replicating"}
        />
        <KpiTile
          size="sm"
          label="Last restore"
          value={lastRestore ? duration(Math.round(lastRestore.durationMs / 1000)) : "None"}
          note={lastRestore ? utc(lastRestore.at) : "Since this node started"}
        />
      </div>

      <div className="flex flex-col">
        <Row label="Leader lease">
          {lease?.holder ? `Held by ${lease.holder}, fencing epoch ${lease.epoch}` : "Nobody holds it"}
        </Row>
        <Row label="Replica">{replication ? <span className="num text-foreground">{replication.replicaId}</span> : "None"}</Row>
        <Row label="Last restore">
          {lastRestore ? (
            <>
              {lastRestore.ok ? (lastRestore.source ? SOURCE_LABELS[lastRestore.source] : "Restored") : "Failed"}
              {lastRestore.replicaId ? (
                <>
                  {" "}
                  (<span className="num">{lastRestore.replicaId}</span>)
                </>
              ) : null}{" "}
              on {utc(lastRestore.at)}
            </>
          ) : (
            "None since this node started"
          )}
        </Row>
        {config && (
          <>
            <Row label="Redis or Valkey">
              {config.redis.mode}, <span className="num">{config.redis.addresses.join(", ")}</span>, key prefix{" "}
              <span className="num">{config.redis.keyPrefix}</span>
              {config.redis.tls ? ", TLS" : ""}
              {config.redis.hasPassword ? ", password set" : ""}
            </Row>
            <Row label="Object storage">
              {config.storage.endpoint ? <span className="num">{config.storage.endpoint}</span> : "AWS S3"}, bucket{" "}
              <span className="num">{config.storage.bucket}</span>, path <span className="num">{config.storage.path}</span>, region{" "}
              <span className="num">{config.storage.region}</span>
            </Row>
            <Row label="Standby copies">
              {config.followIntervalSeconds > 0
                ? `Standbys keep a read-only copy of the database, updated every ${config.followIntervalSeconds} s, for the request-path routes`
                : "Off: standbys keep no copy of the database"}
            </Row>
          </>
        )}
      </div>

      <div className="overflow-x-auto rounded-xl border border-line">
        <Table className="min-w-[640px]">
          <TableHeader>
            <TableRow>
              <TableHead>Node</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Database copy</TableHead>
              <TableHead>Last report</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {view.nodes.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4} className="text-soft">
                  No node has reported yet.
                </TableCell>
              </TableRow>
            ) : (
              view.nodes.map((report) => (
                <TableRow key={report.id}>
                  <TableCell className="num font-medium">
                    {report.id}
                    {report.id === node?.id ? <span className="ml-2 font-sans text-xs text-soft">this node</span> : null}
                  </TableCell>
                  <TableCell>
                    <StatusDot tone={ROLE_TONES[report.role] ?? "off"} label={ROLE_LABELS[report.role] ?? report.role} />
                  </TableCell>
                  <TableCell>{copyLabel(report)}</TableCell>
                  <TableCell className="text-muted-foreground">{utc(report.updatedAt)}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </SectionCard>
  );
}
