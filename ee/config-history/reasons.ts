// SPDX-License-Identifier: Elastic-2.0
/** Why a snapshot was taken. Free of server imports so client components can use it. */
export const SNAPSHOT_REASONS = ["auto", "manual", "before_restore", "import"] as const;
export type SnapshotReason = (typeof SNAPSHOT_REASONS)[number];

export const SNAPSHOT_REASON_LABELS: Record<SnapshotReason, string> = {
  auto: "Automatic",
  manual: "Manual",
  before_restore: "Before restore",
  import: "Before import",
};
