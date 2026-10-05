// SPDX-License-Identifier: Elastic-2.0
"use client";

import { useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/button";
import { KpiTile } from "@/components/ui/KpiTile";
import { SectionCard } from "@/components/ui/SectionCard";
import { StatusDot, type StatusTone } from "@/components/ui/StatusDot";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDateTimeUtc } from "@/src/lib/date-format";
import type { PostgresReplicasView, ReplicaReport } from "../cluster/types";

export const REPLICA_ROLE_LABELS: Record<PostgresReplicasView["role"], string> = {
  leader: "Leader",
  follower: "Follower",
  refused: "Not admitted",
  joining: "Joining",
};

const ROLE_TONES: Record<PostgresReplicasView["role"], StatusTone> = { leader: "ok", follower: "info", refused: "bad", joining: "warn" };

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

function replicaState(replica: ReplicaReport): ReactNode {
  if (replica.status === "stopped") return <StatusDot tone="off" label="Stopped" />;
  if (replica.status === "gone") return <StatusDot tone="warn" label="Gone" />;
  return replica.leader ? <StatusDot tone="ok" label="Leader" /> : <StatusDot tone="info" label="Follower" />;
}

/**
 * The High availability page on PostgreSQL: the replicas sharing the
 * database, which one leads the background jobs, their heartbeats and
 * versions. Read-only: a replica joins by starting with the same database.
 */
export default function PostgresReplicasSection({
  view,
  configurable,
  editionLabel,
}: {
  view: PostgresReplicasView;
  configurable: boolean;
  editionLabel: string;
}) {
  const router = useRouter();
  const [refreshing, startRefresh] = useTransition();
  const versions = new Set(view.nodes.filter((node) => node.status === "live").map((node) => node.version));
  const self = view.nodes.find((node) => node.thisNode) ?? null;

  return (
    <SectionCard
      title="Dashboard cluster"
      description="A replica joins by starting with the same database."
      descriptionPlacement="below"
      headingLevel={2}
      actions={
        <>
          <Badge variant="outline">PostgreSQL mode</Badge>
          <Badge variant="outline">{editionLabel}</Badge>
          <Button variant="outline" size="sm" disabled={refreshing} onClick={() => startRefresh(() => router.refresh())}>
            <RefreshCw className={refreshing ? "animate-spin" : undefined} />
            Refresh
          </Button>
        </>
      }
      padded
      contentClassName="flex flex-col gap-4"
    >
      {view.refusal && (
        <Banner tone="bad" title="This replica was not admitted.">
          {view.refusal}
        </Banner>
      )}
      {!view.refusal && view.election.lastError && (
        <Banner tone="warn" title="This replica is reconnecting to the leader election.">
          {view.election.lastError} ({utc(view.election.lastErrorAt)}). It runs no background jobs until it is connected again;
          the other replicas are not affected.
        </Banner>
      )}
      {view.liveReplicas > 0 && !view.leaderNodeId && (
        <Banner tone="warn" title="No replica leads.">
          No live replica reports the lead, so the background jobs are not running. A replica takes the lead within seconds once
          it can reach the database.
        </Banner>
      )}
      {versions.size > 1 && (
        <Banner tone="warn" title="The replicas run different versions.">
          Run one version on every replica. To upgrade, stop every replica, then start the new version.
        </Banner>
      )}
      {view.liveReplicas > 1 && !configurable && (
        <Banner tone="info" title={`Adding a replica needs an active ${editionLabel} license.`}>
          Replicas that already joined keep running.
        </Banner>
      )}

      <div className="grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] gap-3">
        <KpiTile
          size="sm"
          label="This replica"
          value={<span className="text-[16px]">{view.nodeId ?? "Unknown"}</span>}
          note={<StatusDot tone={ROLE_TONES[view.role]} label={REPLICA_ROLE_LABELS[view.role]} />}
        />
        <KpiTile
          size="sm"
          label="Leader"
          value={<span className="text-[16px]">{view.leaderNodeId ?? "None"}</span>}
          note={view.leaderNodeId ? `Since ${utc(view.nodes.find((node) => node.leader)?.leaderSince ?? null)}` : "No replica leads"}
        />
        <KpiTile
          size="sm"
          label="Live replicas"
          value={String(view.liveReplicas)}
          note={`${view.nodes.length} known`}
        />
        <KpiTile
          size="sm"
          label="Last heartbeat"
          value={<span className="text-[16px]">{self ? formatDateTimeUtc(self.lastHeartbeatAt) : "None"}</span>}
          note="This replica, UTC"
        />
      </div>

      <div className="flex flex-col">
        <Row label="Heartbeat">
          Every {view.heartbeatSeconds} s. A replica silent for {view.goneAfterSeconds} s is gone, and removed after{" "}
          {view.pruneAfterDays} days.
        </Row>
        <Row label="License">
          One replica is free. Each new one needs an active {editionLabel} license, checked once, when it joins
          {configurable ? ": this install has one." : "."}
        </Row>
      </div>

      <div className="overflow-x-auto rounded-xl border border-line">
        <Table className="min-w-[760px]">
          <TableHeader>
            <TableRow>
              <TableHead>Replica</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Last heartbeat</TableHead>
              <TableHead>Version</TableHead>
              <TableHead>Schema</TableHead>
              <TableHead>First seen</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {view.nodes.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-soft">
                  No replica has registered yet.
                </TableCell>
              </TableRow>
            ) : (
              view.nodes.map((replica) => (
                <TableRow key={replica.id}>
                  <TableCell className="num font-medium">
                    {replica.id}
                    {replica.thisNode ? <span className="ml-2 font-sans text-xs text-soft">this replica</span> : null}
                    <div className="font-sans text-xs font-normal text-soft">{replica.hostname}</div>
                  </TableCell>
                  <TableCell>{replicaState(replica)}</TableCell>
                  <TableCell className="text-muted-foreground">{utc(replica.lastHeartbeatAt)}</TableCell>
                  <TableCell className="num">{replica.version}</TableCell>
                  <TableCell className="num">{replica.schemaVersion}</TableCell>
                  <TableCell className="text-muted-foreground">{utc(replica.firstSeenAt)}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </SectionCard>
  );
}
