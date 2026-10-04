// SPDX-License-Identifier: Elastic-2.0
"use client";

import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/EmptyState";
import { SectionCard } from "@/components/ui/SectionCard";
import { StatusDot } from "@/components/ui/StatusDot";
import { formatDateTimeUtc } from "@/src/lib/date-format";
import { describeSchedule, type BackupDestinationView } from "@/ee/backups/types";
import { SettingRow, SettingRows } from "@/src/components/settings/settings-form";
import { RestrictedNotice } from "@/src/components/settings/RestrictedNotice";

/** Scheduled backups as the Settings page summarises them. */
export type BackupsSummaryView = {
  /** backups:read */
  allowed: boolean;
  /** The license allows setting backups up. */
  configurable: boolean;
  editionLabel: string;
  destinations: BackupDestinationView[];
};

const BACKUPS_HREF = "/history?tab=backups";

function host(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return endpoint;
  }
}

function lastRun(destination: BackupDestinationView) {
  if (destination.running) return <StatusDot tone="info" pulse label="Running now" />;
  if (!destination.lastRunAt) return <StatusDot tone="off" label="No backup yet" />;
  if (destination.lastStatus === "failed") {
    return (
      <StatusDot
        tone="bad"
        label={`${formatDateTimeUtc(destination.lastRunAt)} UTC · failed${destination.lastError ? `: ${destination.lastError}` : ""}`}
      />
    );
  }
  return <StatusDot tone="ok" label={`${formatDateTimeUtc(destination.lastSuccessAt ?? destination.lastRunAt)} UTC · succeeded`} />;
}

/** Where scheduled backups go and how the last ones went; they are set up under Change history. */
export function BackupsGroup({ backups }: { backups: BackupsSummaryView }) {
  if (!backups.allowed) {
    return (
      <SectionCard title="Scheduled backups" headingLevel={3} padded>
        <RestrictedNotice permission="backups:read" />
      </SectionCard>
    );
  }
  const description =
    "The configuration export, every secret encrypted with your passphrase, uploaded to your own S3-compatible storage. Users, sessions and API tokens are not included.";
  return (
    <SectionCard
      title="Scheduled backups"
      description={description}
      headingLevel={3}
      divided={false}
      actions={<Badge variant="outline">{backups.editionLabel} and up</Badge>}
      link={backups.destinations.length > 0 ? { label: "Open backups in Change history", href: BACKUPS_HREF } : undefined}
    >
      {backups.destinations.length === 0 ? (
        <div className="border-t border-line">
          <EmptyState
            compact
            headingLevel={4}
            title="No backup destination yet"
            description={
              backups.configurable
                ? "Add a destination under Change history: an S3-compatible bucket, a schedule and a passphrase."
                : `Scheduled backups need an active ${backups.editionLabel} license or higher. A manual export works on every edition.`
            }
            action={
              <Button asChild variant="outline" size="sm">
                <Link href={BACKUPS_HREF}>{backups.configurable ? "Set up backups" : "Open Change history"}</Link>
              </Button>
            }
          />
        </div>
      ) : (
        backups.destinations.map((destination) => (
          <SettingRows key={destination.id}>
            <SettingRow label="Destination">
              <span className="flex min-h-9 flex-wrap items-center gap-2 text-[13px]">
                <span className="font-semibold">{destination.name}</span>
                {!destination.enabled && <Badge variant="muted">Paused</Badge>}
                <span className="text-muted-foreground [overflow-wrap:anywhere]">
                  <span className="num">{host(destination.endpoint)}</span> · bucket <span className="num">{destination.bucket}</span>
                </span>
              </span>
            </SettingRow>
            <SettingRow label="Schedule" note={destination.nextRunAt && destination.enabled ? `Next backup ${formatDateTimeUtc(destination.nextRunAt)} UTC` : undefined}>
              <span className="flex min-h-9 items-center text-[13px]">
                {describeSchedule(destination.schedule, destination.timeZone)} · keeps the last <span className="num px-1">{destination.retention}</span>
              </span>
            </SettingRow>
            <SettingRow label="Last backup">
              <span className="flex min-h-9 items-center text-[13px] [overflow-wrap:anywhere]">{lastRun(destination)}</span>
            </SettingRow>
            <SettingRow label="Passphrase" note="Restoring on a new machine needs it. Keep a copy in your password manager.">
              <span className="flex min-h-9 items-center text-[13px]">
                {destination.hasPassphrase ? "Stored encrypted on this install" : "Not set"}
              </span>
            </SettingRow>
          </SettingRows>
        ))
      )}
    </SectionCard>
  );
}
