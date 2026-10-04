-- Compliance reports (ee, paid feature "compliance_reports"): generated
-- reports with their SHA-256, and NIS2 incident notification drafts.
CREATE TABLE `compliance_reports` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`uid` text NOT NULL,
	`type` text NOT NULL,
	`periodFrom` text NOT NULL,
	`periodTo` text NOT NULL,
	`generatedAt` text NOT NULL,
	`generatedBy` integer,
	`generatedByName` text,
	`sha256` text NOT NULL,
	`findingCounts` text DEFAULT '{}' NOT NULL,
	`sizeBytes` integer NOT NULL,
	`content` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `compliance_reports_uid_unique` ON `compliance_reports` (`uid`);
--> statement-breakpoint
CREATE INDEX `compliance_reports_generated_at_idx` ON `compliance_reports` (`generatedAt`);
--> statement-breakpoint
CREATE INDEX `compliance_reports_type_idx` ON `compliance_reports` (`type`);
--> statement-breakpoint
CREATE TABLE `compliance_incidents` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`title` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`language` text DEFAULT 'en' NOT NULL,
	`detectedAt` text NOT NULL,
	`periodFrom` text NOT NULL,
	`periodTo` text NOT NULL,
	`alertEventId` integer,
	`proxyHostIds` text DEFAULT '[]' NOT NULL,
	`facts` text,
	`factsCollectedAt` text,
	`stages` text DEFAULT '{}' NOT NULL,
	`createdBy` integer,
	`createdByName` text,
	`createdAt` text NOT NULL,
	`updatedBy` integer,
	`updatedAt` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `compliance_incidents_detected_at_idx` ON `compliance_incidents` (`detectedAt`);
