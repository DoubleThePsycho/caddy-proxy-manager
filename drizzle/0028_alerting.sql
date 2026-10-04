-- Alerting (ee): notification channels, rules, per-rule state and history.
CREATE TABLE `alert_channels` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`config` text DEFAULT '{}' NOT NULL,
	`secrets` text,
	`lastDeliveryAt` text,
	`lastDeliveryError` text,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `alert_rules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`params` text DEFAULT '{}' NOT NULL,
	`channelIds` text DEFAULT '[]' NOT NULL,
	`cooldownMinutes` integer DEFAULT 60 NOT NULL,
	`notifyOnResolve` integer DEFAULT true NOT NULL,
	`explain` integer DEFAULT false NOT NULL,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `alert_rule_states` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ruleId` integer NOT NULL,
	`subjectKey` text NOT NULL,
	`status` text NOT NULL,
	`title` text,
	`firedAt` text,
	`resolvedAt` text,
	`lastNotifiedAt` text,
	`notifiedFiring` integer DEFAULT false NOT NULL,
	`lastEvaluatedAt` text NOT NULL,
	FOREIGN KEY (`ruleId`) REFERENCES `alert_rules`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `alert_rule_states_rule_subject_unique` ON `alert_rule_states` (`ruleId`,`subjectKey`);
--> statement-breakpoint
CREATE TABLE `alert_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ruleId` integer NOT NULL,
	`ruleName` text NOT NULL,
	`ruleType` text NOT NULL,
	`subjectKey` text NOT NULL,
	`status` text NOT NULL,
	`severity` text NOT NULL,
	`title` text NOT NULL,
	`message` text NOT NULL,
	`facts` text,
	`explanation` text,
	`notified` integer DEFAULT false NOT NULL,
	`deliveries` text,
	`createdAt` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `alert_events_created_at_idx` ON `alert_events` (`createdAt`);
--> statement-breakpoint
CREATE INDEX `alert_events_rule_idx` ON `alert_events` (`ruleId`);
