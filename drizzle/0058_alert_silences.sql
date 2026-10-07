-- Dismissing and muting alerts (ee/alerting/silences.ts).
-- alert_silences: a whole rule muted until a time (no subjectKey), or one
-- alert dismissed until a time or, with no `until`, until it resolves. The
-- ruleId reference is not enforced: deleting a rule deletes its rows in code.
-- alert_events.silenced: "muted" or "dismissed" when a mute or dismissal held
-- the firing notification back.
CREATE TABLE `alert_silences` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ruleId` integer NOT NULL,
	`subjectKey` text,
	`until` text,
	`note` text,
	`createdBy` integer,
	`createdAt` text NOT NULL,
	FOREIGN KEY (`ruleId`) REFERENCES `alert_rules`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `alert_silences_rule_idx` ON `alert_silences` (`ruleId`,`subjectKey`);
--> statement-breakpoint
ALTER TABLE `alert_events` ADD `silenced` text;
