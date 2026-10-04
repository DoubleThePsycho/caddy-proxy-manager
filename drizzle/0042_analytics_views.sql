-- Named analytics views: a range, filters, metric and grouping a user saved,
-- optionally shared with the analytics readers of their organisation (or of
-- the provider level when organizationId is null). No foreign key: deleting a
-- user deletes their views in the application (deleteUser).
CREATE TABLE `analytics_saved_views` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`userId` integer NOT NULL,
	`organizationId` integer,
	`name` text NOT NULL,
	`shared` integer DEFAULT false NOT NULL,
	`range` text NOT NULL,
	`filters` text DEFAULT '[]' NOT NULL,
	`metric` text DEFAULT 'requests' NOT NULL,
	`groupBy` text,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `analytics_saved_views_user_idx` ON `analytics_saved_views` (`userId`);
--> statement-breakpoint
CREATE INDEX `analytics_saved_views_shared_idx` ON `analytics_saved_views` (`organizationId`, `shared`);
