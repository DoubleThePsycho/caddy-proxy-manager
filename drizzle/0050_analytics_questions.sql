-- Plain-language analytics questions (ee/ai/questions): the questions users
-- saved, with the validated structured query each was turned into,
-- optionally shared with the analytics readers of their organisation (or of
-- the provider level when organizationId is null). No foreign key: deleting
-- a user deletes their questions in the application (deleteUser).
CREATE TABLE `analytics_questions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`userId` integer NOT NULL,
	`organizationId` integer,
	`question` text NOT NULL,
	`query` text NOT NULL,
	`shared` integer DEFAULT false NOT NULL,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `analytics_questions_user_idx` ON `analytics_questions` (`userId`);
--> statement-breakpoint
CREATE INDEX `analytics_questions_shared_idx` ON `analytics_questions` (`organizationId`, `shared`);
--> statement-breakpoint
-- Compliance (ee): saved questions copied into a report schedule; each run
-- adds a "Traffic questions" report that re-runs them for the period.
ALTER TABLE `compliance_report_schedules` ADD `questions` text DEFAULT '[]' NOT NULL;
