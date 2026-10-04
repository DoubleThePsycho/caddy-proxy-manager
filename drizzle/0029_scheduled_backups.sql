-- Scheduled backups (ee, paid feature "scheduled_backups"): S3-compatible
-- destinations and the record of each backup attempt.
CREATE TABLE `backup_destinations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`endpoint` text NOT NULL,
	`region` text NOT NULL,
	`bucket` text NOT NULL,
	`keyPrefix` text DEFAULT '' NOT NULL,
	`pathStyle` integer DEFAULT false NOT NULL,
	`accessKeyId` text NOT NULL,
	`secretAccessKey` text NOT NULL,
	`passphrase` text NOT NULL,
	`schedule` text NOT NULL,
	`timeZone` text DEFAULT 'UTC' NOT NULL,
	`retention` integer DEFAULT 30 NOT NULL,
	`nextRunAt` text,
	`lastRunAt` text,
	`lastStatus` text,
	`lastError` text,
	`lastSuccessAt` text,
	`consecutiveFailures` integer DEFAULT 0 NOT NULL,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `backup_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`destinationId` integer NOT NULL,
	`trigger` text NOT NULL,
	`status` text NOT NULL,
	`startedAt` text NOT NULL,
	`finishedAt` text,
	`objectKey` text,
	`sizeBytes` integer,
	`sha256` text,
	`prunedCount` integer,
	`error` text,
	`warning` text
);
--> statement-breakpoint
CREATE INDEX `backup_runs_destination_idx` ON `backup_runs` (`destinationId`,`id`);
--> statement-breakpoint
CREATE INDEX `backup_runs_started_at_idx` ON `backup_runs` (`startedAt`);
