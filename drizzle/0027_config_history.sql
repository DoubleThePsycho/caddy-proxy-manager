-- Configuration history (ee): snapshots of the configuration Caddy serves.
-- userId only records who caused a snapshot and is deliberately not a foreign
-- key, so deleting a user never touches history.
CREATE TABLE `config_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`createdAt` text NOT NULL,
	`userId` integer,
	`reason` text NOT NULL,
	`summary` text NOT NULL,
	`fingerprint` text NOT NULL,
	`content` text NOT NULL,
	`sizeBytes` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `config_snapshots_created_at_idx` ON `config_snapshots` (`createdAt`);
