-- Fleet management (ee, paid feature "fleet"): environments of sync slaves,
-- the revisions promotion-only environments are pinned to, rollouts with
-- their per-instance targets, and what the master knows about each slave.
CREATE TABLE `fleet_environments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`position` integer NOT NULL,
	`promotionOnly` integer DEFAULT false NOT NULL,
	`revisionId` integer,
	`canaryEnabled` integer DEFAULT true NOT NULL,
	`canaryWaitSeconds` integer DEFAULT 300 NOT NULL,
	`checkCaddyStatus` integer DEFAULT true NOT NULL,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `fleet_environments_name_unique` ON `fleet_environments` (`name`);
--> statement-breakpoint
CREATE TABLE `fleet_instances` (
	`instanceId` integer PRIMARY KEY NOT NULL,
	`environmentId` integer,
	`revisionId` integer,
	`pushedFingerprint` text,
	`pushedAt` text,
	`driftStatus` text,
	`driftCheckedAt` text,
	`driftSince` text,
	`driftDetail` text,
	`reportedFingerprint` text,
	`reportedVersion` text,
	`localChanges` integer,
	`updatedAt` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `fleet_instances_environment_idx` ON `fleet_instances` (`environmentId`);
--> statement-breakpoint
CREATE TABLE `fleet_revisions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`createdAt` text NOT NULL,
	`createdBy` integer,
	`summary` text NOT NULL,
	`fingerprint` text NOT NULL,
	`content` text NOT NULL,
	`sizeBytes` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `fleet_revisions_fingerprint_idx` ON `fleet_revisions` (`fingerprint`);
--> statement-breakpoint
CREATE TABLE `fleet_rollouts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`environmentId` integer NOT NULL,
	`revisionId` integer NOT NULL,
	`fromRevisionId` integer,
	`kind` text NOT NULL,
	`sourceEnvironmentId` integer,
	`rollbackOfId` integer,
	`status` text NOT NULL,
	`phase` text NOT NULL,
	`canaryInstanceId` integer,
	`canaryWaitSeconds` integer DEFAULT 0 NOT NULL,
	`checkCaddyStatus` integer DEFAULT false NOT NULL,
	`observeUntil` text,
	`lastCheckAt` text,
	`error` text,
	`startedBy` integer,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL,
	`finishedAt` text
);
--> statement-breakpoint
CREATE INDEX `fleet_rollouts_environment_idx` ON `fleet_rollouts` (`environmentId`,`id`);
--> statement-breakpoint
CREATE INDEX `fleet_rollouts_status_idx` ON `fleet_rollouts` (`status`);
--> statement-breakpoint
CREATE TABLE `fleet_rollout_targets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`rolloutId` integer NOT NULL,
	`instanceId` integer NOT NULL,
	`instanceName` text NOT NULL,
	`role` text NOT NULL,
	`status` text NOT NULL,
	`error` text,
	`syncedAt` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `fleet_rollout_targets_rollout_instance_unique` ON `fleet_rollout_targets` (`rolloutId`,`instanceId`);
