-- Tamper-evident hash chain for the audit log (src/lib/audit-chain.ts). Events
-- recorded before this migration keep NULL hashes; the chain starts at the
-- first event recorded after it.
ALTER TABLE `audit_events` ADD `prevHash` text;
--> statement-breakpoint
ALTER TABLE `audit_events` ADD `hash` text;
--> statement-breakpoint
ALTER TABLE `audit_events` ADD `actorDigest` text;
--> statement-breakpoint
CREATE INDEX `audit_events_created_at_idx` ON `audit_events` (`createdAt`);
--> statement-breakpoint
-- Audit streaming destinations (ee/audit, paid feature "audit_streaming").
CREATE TABLE `audit_sinks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`config` text NOT NULL,
	`secret` text,
	`lastDeliveredId` integer DEFAULT 0 NOT NULL,
	`lastDeliveryAt` text,
	`lastError` text,
	`lastErrorAt` text,
	`consecutiveFailures` integer DEFAULT 0 NOT NULL,
	`nextAttemptAt` text,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL
);
