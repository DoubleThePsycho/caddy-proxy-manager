"use client";

import { PageHeader } from "@/components/ui/PageHeader";
import { SectionCard } from "@/components/ui/SectionCard";
import { RestrictedNotice } from "@/src/components/settings/RestrictedNotice";
import { useUnsavedWarning } from "../settings/use-unsaved-warning";
import SyncGroup from "./SyncGroup";
import type { InstancesClientProps } from "./types";

// The dialogs of the page, rendered on their own by tests.
export { EditSlaveInstanceForm, RemovePinnedSlaveConfirmation, SyncKeyPinDialogBody } from "./SyncGroup";

/** Instance sync: this instance's mode, a master's replicas and their key pins, a replica's master connection. */
export default function InstancesClient({ instanceSync, canWrite, canOpenFleet }: InstancesClientProps) {
  const onDirtyChange = useUnsavedWarning();
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        className="mb-0"
        breadcrumb={["Platform", canOpenFleet ? { label: "Fleet", href: "/fleet" } : "Fleet", "Instance sync"]}
        title="Instance sync"
      />
      {instanceSync ? (
        <SyncGroup instanceSync={instanceSync} canSave={canWrite} onDirtyChange={onDirtyChange} />
      ) : (
        <SectionCard title="Instance sync" headingLevel={2} padded>
          <RestrictedNotice permission="instances:read" />
        </SectionCard>
      )}
    </div>
  );
}
