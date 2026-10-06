-- Multi-tenancy (drizzle/0041) was withdrawn: organisations and every
-- organizationId column go, and the rows they held belong to the install.
-- Organisation users are disabled and become viewers, so none of them gains
-- read access to the whole install; their sessions end. Group names were
-- unique per organisation: a group that shares its name with another gets
-- its organisation's slug appended (then its id, if that still clashes).
DROP TRIGGER IF EXISTS `users_organization_role_insert`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `users_organization_role_update`;
--> statement-breakpoint
DELETE FROM `forward_auth_exchanges` WHERE `sessionId` IN (
	SELECT `id` FROM `forward_auth_sessions` WHERE `userId` IN (SELECT `id` FROM `users` WHERE `organizationId` IS NOT NULL)
);
--> statement-breakpoint
DELETE FROM `forward_auth_sessions` WHERE `userId` IN (SELECT `id` FROM `users` WHERE `organizationId` IS NOT NULL);
--> statement-breakpoint
DELETE FROM `sessions` WHERE `userId` IN (SELECT `id` FROM `users` WHERE `organizationId` IS NOT NULL);
--> statement-breakpoint
UPDATE `users`
SET `role` = 'viewer', `customRoleId` = NULL, `status` = 'disabled', `updatedAt` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE `organizationId` IS NOT NULL;
--> statement-breakpoint
UPDATE `groups`
SET `name` = `name` || ' (' || coalesce(
	(SELECT `slug` FROM `organizations` WHERE `organizations`.`id` = `groups`.`organizationId`),
	'organisation ' || `organizationId`
) || ')'
WHERE `organizationId` IS NOT NULL
	AND `name` IN (SELECT `name` FROM `groups` GROUP BY `name` HAVING count(*) > 1);
--> statement-breakpoint
UPDATE `groups`
SET `name` = `name` || ' #' || `id`
WHERE `organizationId` IS NOT NULL
	AND `name` IN (SELECT `name` FROM `groups` GROUP BY `name` HAVING count(*) > 1);
--> statement-breakpoint
DROP INDEX IF EXISTS `groups_organization_name_unique`;
--> statement-breakpoint
CREATE UNIQUE INDEX `groups_name_unique` ON `groups` (`name`);
--> statement-breakpoint
DROP INDEX IF EXISTS `users_organization_idx`;
--> statement-breakpoint
DROP INDEX IF EXISTS `proxy_hosts_organization_idx`;
--> statement-breakpoint
DROP INDEX IF EXISTS `certificates_organization_idx`;
--> statement-breakpoint
DROP INDEX IF EXISTS `access_lists_organization_idx`;
--> statement-breakpoint
DROP INDEX IF EXISTS `audit_events_organization_idx`;
--> statement-breakpoint
DROP INDEX IF EXISTS `analytics_saved_views_shared_idx`;
--> statement-breakpoint
CREATE INDEX `analytics_saved_views_shared_idx` ON `analytics_saved_views` (`shared`);
--> statement-breakpoint
DROP INDEX IF EXISTS `analytics_questions_shared_idx`;
--> statement-breakpoint
CREATE INDEX `analytics_questions_shared_idx` ON `analytics_questions` (`shared`);
--> statement-breakpoint
ALTER TABLE `users` DROP COLUMN `organizationId`;
--> statement-breakpoint
ALTER TABLE `proxy_hosts` DROP COLUMN `organizationId`;
--> statement-breakpoint
ALTER TABLE `certificates` DROP COLUMN `organizationId`;
--> statement-breakpoint
ALTER TABLE `access_lists` DROP COLUMN `organizationId`;
--> statement-breakpoint
ALTER TABLE `groups` DROP COLUMN `organizationId`;
--> statement-breakpoint
ALTER TABLE `audit_events` DROP COLUMN `organizationId`;
--> statement-breakpoint
ALTER TABLE `analytics_saved_views` DROP COLUMN `organizationId`;
--> statement-breakpoint
ALTER TABLE `analytics_questions` DROP COLUMN `organizationId`;
--> statement-breakpoint
DROP TABLE IF EXISTS `organizations`;
