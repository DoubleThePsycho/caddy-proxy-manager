-- Multi-tenancy (ee, paid feature "multi_tenancy"): client organisations of a
-- managed service provider. users, proxy_hosts, certificates, access_lists,
-- groups and audit_events gain organizationId; null is the provider level, so
-- every existing row stays exactly where it was. Organisation ids are never
-- reused (AUTOINCREMENT).
CREATE TABLE `organizations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`maxProxyHosts` integer,
	`maxUsers` integer,
	`allowedUpstreams` text DEFAULT '[]' NOT NULL,
	`notes` text,
	`createdBy` integer,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organizations_slug_unique` ON `organizations` (`slug`);
--> statement-breakpoint
ALTER TABLE `users` ADD `organizationId` integer;
--> statement-breakpoint
CREATE INDEX `users_organization_idx` ON `users` (`organizationId`);
--> statement-breakpoint
ALTER TABLE `proxy_hosts` ADD `organizationId` integer;
--> statement-breakpoint
CREATE INDEX `proxy_hosts_organization_idx` ON `proxy_hosts` (`organizationId`);
--> statement-breakpoint
ALTER TABLE `certificates` ADD `organizationId` integer;
--> statement-breakpoint
CREATE INDEX `certificates_organization_idx` ON `certificates` (`organizationId`);
--> statement-breakpoint
ALTER TABLE `access_lists` ADD `organizationId` integer;
--> statement-breakpoint
CREATE INDEX `access_lists_organization_idx` ON `access_lists` (`organizationId`);
--> statement-breakpoint
ALTER TABLE `groups` ADD `organizationId` integer;
--> statement-breakpoint
-- Group names are unique per organisation (the provider level counts as one):
-- one organisation's names neither block nor reveal another's.
DROP INDEX IF EXISTS `groups_name_unique`;
--> statement-breakpoint
CREATE UNIQUE INDEX `groups_organization_name_unique` ON `groups` (ifnull(`organizationId`, 0), `name`);
--> statement-breakpoint
ALTER TABLE `audit_events` ADD `organizationId` integer;
--> statement-breakpoint
CREATE INDEX `audit_events_organization_idx` ON `audit_events` (`organizationId`, `id`);
--> statement-breakpoint
-- Defence in depth: an organisation user is never the provider's built-in
-- administrator, and only organisation users are organisation administrators.
-- The application refuses both first; these triggers stop any code path that
-- would not.
CREATE TRIGGER `users_organization_role_insert` BEFORE INSERT ON `users`
WHEN (NEW.`organizationId` IS NOT NULL AND NEW.`role` = 'admin')
  OR (NEW.`organizationId` IS NULL AND NEW.`role` = 'org_admin')
BEGIN
	SELECT RAISE(ABORT, 'organization role mismatch');
END;
--> statement-breakpoint
CREATE TRIGGER `users_organization_role_update` BEFORE UPDATE OF `role`, `organizationId` ON `users`
WHEN (NEW.`organizationId` IS NOT NULL AND NEW.`role` = 'admin')
  OR (NEW.`organizationId` IS NULL AND NEW.`role` = 'org_admin')
BEGIN
	SELECT RAISE(ABORT, 'organization role mismatch');
END;
