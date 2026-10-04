-- Fleet pull replicas (ee, paid feature "fleet"): instances that fetch their
-- configuration from the master instead of being pushed to, their
-- credentials (hashed), what they last reported and what the master last
-- sent them, and when a rollout asked a pull replica to take its revision.
ALTER TABLE `instances` ADD `syncMode` text DEFAULT 'push' NOT NULL;
--> statement-breakpoint
ALTER TABLE `fleet_rollout_targets` ADD `requestedAt` text;
--> statement-breakpoint
CREATE TABLE `fleet_pull_replicas` (
	`instanceId` integer PRIMARY KEY NOT NULL,
	`credentialHash` text,
	`credentialPrefix` text,
	`credentialCreatedAt` text,
	`fingerprintToken` text,
	`pollIntervalSeconds` integer,
	`lastSeenAt` text,
	`lastSeenAddress` text,
	`lastStatus` text,
	`deliveredFingerprint` text,
	`deliveredRevisionId` integer,
	`deliveredAt` text,
	`resyncRequestedAt` text,
	`resyncRevisionId` integer,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `fleet_pull_replicas_credential_hash_unique` ON `fleet_pull_replicas` (`credentialHash`);
