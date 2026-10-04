-- Custom roles (ee/custom-roles) and host tags (Community).
-- custom_roles holds named permission sets (src/lib/permissions.ts) with an
-- optional tag scope; users.customRoleId points at one of them (null for a
-- built-in role). proxy_hosts.tags and l4_proxy_hosts.tags are free-form
-- labels stored as JSON arrays.
CREATE TABLE `custom_roles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`permissions` text DEFAULT '[]' NOT NULL,
	`scopeTags` text DEFAULT '[]' NOT NULL,
	`createdBy` integer,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL,
	FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `custom_roles_name_unique` ON `custom_roles` (`name`);
--> statement-breakpoint
ALTER TABLE `users` ADD `customRoleId` integer;
--> statement-breakpoint
ALTER TABLE `proxy_hosts` ADD `tags` text DEFAULT '[]' NOT NULL;
--> statement-breakpoint
ALTER TABLE `l4_proxy_hosts` ADD `tags` text DEFAULT '[]' NOT NULL;
