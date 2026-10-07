// SPDX-License-Identifier: Elastic-2.0
/**
 * Scheduled backups: types and constants shared with client components. No
 * Node.js imports here.
 */

export const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export const WEEKDAY_LABELS: Record<Weekday, string> = {
  sunday: "Sunday",
  monday: "Monday",
  tuesday: "Tuesday",
  wednesday: "Wednesday",
  thursday: "Thursday",
  friday: "Friday",
  saturday: "Saturday",
};

export const SCHEDULE_KINDS = ["hourly", "daily", "weekly"] as const;
export type ScheduleKind = (typeof SCHEDULE_KINDS)[number];

/** Times are local wall-clock times in the destination's time zone. */
export type BackupSchedule =
  | { kind: "hourly"; minute: number }
  | { kind: "daily"; time: string }
  | { kind: "weekly"; day: Weekday; time: string };

export const DEFAULT_SCHEDULE: BackupSchedule = { kind: "daily", time: "03:00" };
export const DEFAULT_RETENTION = 30;
export const MIN_RETENTION = 1;
export const MAX_RETENTION = 1000;
export const DEFAULT_REGION = "us-east-1";

/** Backup files are named BACKUP_FILE_PREFIX + ISO time with ":" replaced by "-" + ".json". */
export const BACKUP_FILE_PREFIX = "ingressi-config-";
export const BACKUP_FILE_PATTERN = /^ingressi-config-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:\.\d{3})?Z\.json$/;

export type BackupRunStatus = "running" | "success" | "failed";
export type BackupTrigger = "schedule" | "manual";

/** What the API and the dashboard see of a destination. Secrets are never included. */
export type BackupDestinationView = {
  id: number;
  name: string;
  enabled: boolean;
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  pathStyle: boolean;
  accessKeyId: string;
  hasSecretAccessKey: boolean;
  hasPassphrase: boolean;
  schedule: BackupSchedule;
  timeZone: string;
  retention: number;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: "success" | "failed" | null;
  lastError: string | null;
  lastSuccessAt: string | null;
  consecutiveFailures: number;
  /** A backup to this destination is in progress. */
  running: boolean;
  createdAt: string;
  updatedAt: string;
};

export type BackupRunView = {
  id: number;
  destinationId: number;
  destinationName: string | null;
  trigger: BackupTrigger;
  status: BackupRunStatus;
  startedAt: string;
  finishedAt: string | null;
  objectKey: string | null;
  sizeBytes: number | null;
  sha256: string | null;
  prunedCount: number | null;
  error: string | null;
  warning: string | null;
};

export type BackupRunsPage = { runs: BackupRunView[]; total: number; page: number; perPage: number };

export type BackupObjectView = { key: string; sizeBytes: number; lastModified: string | null };

export type BackupObjectsListing = {
  objects: BackupObjectView[];
  /** False when the bucket listing was cut short; the newest files may be missing. */
  complete: boolean;
};

export type BackupTestStep = "write" | "read" | "delete";

export type BackupTestResult = {
  ok: boolean;
  error: string | null;
  /** The step that failed. */
  failedStep: BackupTestStep | null;
  durationMs: number;
};

export type BackupRestoreResult = {
  key: string;
  counts: Record<string, number>;
  warning: string | null;
  /** Configuration history snapshot of the configuration the restore replaced (when history is on). */
  beforeSnapshotId: number | null;
};

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

export function describeSchedule(schedule: BackupSchedule, timeZone: string): string {
  switch (schedule.kind) {
    case "hourly":
      return `Hourly at minute ${pad(schedule.minute)} (${timeZone})`;
    case "daily":
      return `Daily at ${schedule.time} (${timeZone})`;
    case "weekly":
      return `${WEEKDAY_LABELS[schedule.day]}s at ${schedule.time} (${timeZone})`;
  }
}

/** Provider presets for the dashboard form; the endpoint has placeholders in angle brackets. */
export const STORAGE_PRESETS = [
  { id: "aws", label: "Amazon S3", endpoint: "https://s3.<region>.amazonaws.com", region: "eu-central-1", pathStyle: false },
  { id: "r2", label: "Cloudflare R2", endpoint: "https://<account-id>.r2.cloudflarestorage.com", region: "auto", pathStyle: true },
  { id: "b2", label: "Backblaze B2", endpoint: "https://s3.<region>.backblazeb2.com", region: "eu-central-003", pathStyle: false },
  { id: "hetzner", label: "Hetzner Object Storage", endpoint: "https://<location>.your-objectstorage.com", region: "fsn1", pathStyle: false },
  { id: "wasabi", label: "Wasabi", endpoint: "https://s3.<region>.wasabisys.com", region: "eu-central-1", pathStyle: false },
  { id: "minio", label: "MinIO / self-hosted", endpoint: "http://minio:9000", region: "us-east-1", pathStyle: true },
] as const;
