// SPDX-License-Identifier: Elastic-2.0
"use client";

import { Banner } from "@/components/ui/Banner";
import { SectionCard } from "@/components/ui/SectionCard";
import { formatDateTimeUtc } from "@/src/lib/date-format";
import { CardNote, SettingRow, SettingRows } from "@/src/components/settings/settings-form";
import type { PullAgentStatus } from "@/ee/fleet/pull-agent";

/** What the Instance sync page knows of this replica's sync. */
export type PullAgentReplica = {
  lastSyncAt: string | null;
  lastSyncError: string | null;
  syncKeyId: string;
  syncPublicKey: string;
};

function at(value: string | null): string {
  return value ? `${formatDateTimeUtc(value)} UTC` : "never";
}

/** A pull replica's own view: where it polls, and how its last polls went. */
export function PullAgentCard({ pull, slave }: { pull: PullAgentStatus; slave: PullAgentReplica }) {
  return (
    <SectionCard
      title="Master connection (pull)"
      description="Polls its master and accepts no pushes. Set with environment variables (INSTANCE_SYNC_MODE=pull)."
      headingLevel={3}
      divided={false}
    >
      {pull.configError && (
        <div className="px-5 pb-3">
          <Banner tone="warn">{pull.configError}</Banner>
        </div>
      )}
      <SettingRows>
        <SettingRow label="Master">
          <span className="num flex min-h-9 items-center text-[13px] [overflow-wrap:anywhere]">{pull.masterUrl ?? "not configured"}</span>
        </SettingRow>
        <SettingRow label="Poll interval">
          <span className="num flex min-h-9 items-center text-[13px]">{pull.intervalSeconds ? `${pull.intervalSeconds} s` : "–"}</span>
        </SettingRow>
        <SettingRow label="Last check-in">
          <span className="flex min-h-9 items-center text-[13px]">{at(pull.lastCheckInAt)}</span>
        </SettingRow>
        <SettingRow label="Last configuration applied">
          <span className="flex min-h-9 items-center text-[13px]">{at(pull.lastAppliedAt)}</span>
        </SettingRow>
        <SettingRow label="Sync key id">
          <span className="num flex min-h-9 items-center text-[13px]">{slave.syncKeyId}</span>
        </SettingRow>
        <SettingRow label="Sync public key" hint="Changes with SESSION_SECRET.">
          <span className="num flex min-h-9 items-center text-[13px] break-all">{slave.syncPublicKey}</span>
        </SettingRow>
      </SettingRows>
      {pull.lastError && (
        <CardNote tone="warn">{`Last poll: ${pull.lastError}${pull.lastErrorAt ? ` (${at(pull.lastErrorAt)})` : ""}`}</CardNote>
      )}
      {slave.lastSyncError && <CardNote tone="warn">{`Last sync: ${slave.lastSyncAt ?? "never"} (${slave.lastSyncError})`}</CardNote>}
    </SectionCard>
  );
}
