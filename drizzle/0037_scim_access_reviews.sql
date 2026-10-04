-- SCIM 2.0 provisioning (ee/scim) and access reviews (ee/access-reviews).
-- scim_tokens are SCIM-only bearer tokens (SHA-256 stored). scim_users and
-- scim_groups mark the users and forward-auth groups SCIM manages;
-- scim_group_members are the memberships the identity provider asserted;
-- scim_role_mappings map a SCIM group to a role. access_review_* hold review
-- campaigns, their items and recurring schedules. No foreign keys to users or
-- groups: the models delete these rows explicitly.
CREATE TABLE `scim_tokens` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`prefix` text NOT NULL,
	`tokenHash` text NOT NULL,
	`createdBy` integer,
	`createdAt` text NOT NULL,
	`lastUsedAt` text,
	`expiresAt` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scim_tokens_token_hash_unique` ON `scim_tokens` (`tokenHash`);
--> statement-breakpoint
CREATE TABLE `scim_users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`userId` integer NOT NULL,
	`userName` text NOT NULL,
	`userNameKey` text NOT NULL,
	`externalId` text,
	`displayName` text,
	`givenName` text,
	`familyName` text,
	`formattedName` text,
	`emails` text DEFAULT '[]' NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`origin` text DEFAULT 'scim' NOT NULL,
	`deletedAt` text,
	`linkedAt` text,
	`createdByTokenId` integer,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scim_users_user_unique` ON `scim_users` (`userId`);
--> statement-breakpoint
CREATE UNIQUE INDEX `scim_users_user_name_key_unique` ON `scim_users` (`userNameKey`);
--> statement-breakpoint
CREATE INDEX `scim_users_external_id_idx` ON `scim_users` (`externalId`);
--> statement-breakpoint
CREATE TABLE `scim_groups` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`groupId` integer NOT NULL,
	`externalId` text,
	`origin` text DEFAULT 'scim' NOT NULL,
	`createdByTokenId` integer,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scim_groups_group_unique` ON `scim_groups` (`groupId`);
--> statement-breakpoint
CREATE TABLE `scim_group_members` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`groupId` integer NOT NULL,
	`userId` integer NOT NULL,
	`createdAt` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scim_group_members_unique` ON `scim_group_members` (`groupId`,`userId`);
--> statement-breakpoint
CREATE INDEX `scim_group_members_user_idx` ON `scim_group_members` (`userId`);
--> statement-breakpoint
CREATE TABLE `scim_role_mappings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`groupId` integer NOT NULL,
	`role` text NOT NULL,
	`customRoleId` integer,
	`priority` integer DEFAULT 100 NOT NULL,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scim_role_mappings_group_unique` ON `scim_role_mappings` (`groupId`);
--> statement-breakpoint
CREATE TABLE `access_review_campaigns` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`scope` text DEFAULT '{"type":"all"}' NOT NULL,
	`reviewerIds` text DEFAULT '[]' NOT NULL,
	`dueAt` text NOT NULL,
	`startedAt` text NOT NULL,
	`completedAt` text,
	`cancelledAt` text,
	`scheduleId` integer,
	`createdBy` integer,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `access_review_campaigns_status_idx` ON `access_review_campaigns` (`status`);
--> statement-breakpoint
CREATE TABLE `access_review_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`campaignId` integer NOT NULL,
	`subjectUserId` integer NOT NULL,
	`subjectEmail` text NOT NULL,
	`subjectName` text,
	`kind` text NOT NULL,
	`targetId` integer,
	`targetLabel` text NOT NULL,
	`decision` text,
	`comment` text,
	`decidedBy` integer,
	`decidedByEmail` text,
	`decidedAt` text,
	`confirmedAt` text,
	`outcome` text,
	`outcomeDetail` text,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `access_review_items_campaign_idx` ON `access_review_items` (`campaignId`,`subjectUserId`);
--> statement-breakpoint
CREATE TABLE `access_review_schedules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`scope` text DEFAULT '{"type":"all"}' NOT NULL,
	`reviewerIds` text DEFAULT '[]' NOT NULL,
	`durationDays` integer DEFAULT 14 NOT NULL,
	`intervalMonths` integer DEFAULT 3 NOT NULL,
	`nextRunAt` text NOT NULL,
	`lastRunAt` text,
	`lastCampaignId` integer,
	`lastError` text,
	`createdBy` integer,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL
);
