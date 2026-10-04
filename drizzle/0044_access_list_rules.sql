-- Access lists v2 (Community): ordered allow/deny rules by IP address or
-- CIDR range, country, continent or AS number, next to the basic-auth
-- members. Rules are checked in order and the first match decides; a request
-- that matches no rule gets the list's defaultAction. A denied request gets
-- denyStatus and denyBody, or a 302 to denyRedirectUrl. systemKey marks the
-- global "Blocked sources" list ('blocked_sources'), which applies to every
-- host and is created on first use.
ALTER TABLE `access_lists` ADD `defaultAction` text DEFAULT 'allow' NOT NULL;
--> statement-breakpoint
ALTER TABLE `access_lists` ADD `denyStatus` integer DEFAULT 403 NOT NULL;
--> statement-breakpoint
ALTER TABLE `access_lists` ADD `denyBody` text;
--> statement-breakpoint
ALTER TABLE `access_lists` ADD `denyRedirectUrl` text;
--> statement-breakpoint
ALTER TABLE `access_lists` ADD `failClosed` integer DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE `access_lists` ADD `systemKey` text;
--> statement-breakpoint
CREATE UNIQUE INDEX `access_lists_system_key_unique` ON `access_lists` (`systemKey`);
--> statement-breakpoint
CREATE TABLE `access_list_rules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`accessListId` integer NOT NULL,
	`position` integer NOT NULL,
	`action` text NOT NULL,
	`kind` text NOT NULL,
	`matchValues` text NOT NULL,
	`note` text,
	`expiresAt` text,
	`createdBy` integer,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL,
	FOREIGN KEY (`accessListId`) REFERENCES `access_lists`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `access_list_rules_list_position_idx` ON `access_list_rules` (`accessListId`,`position`);
--> statement-breakpoint
CREATE INDEX `access_list_rules_expires_idx` ON `access_list_rules` (`expiresAt`);
