-- Change approvals (ee/approvals): approval policies for protected hosts,
-- change requests waiting for (or past) their approvals, and the approvals,
-- rejections and comments on them.
CREATE TABLE `approval_policies` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`enabled` integer DEFAULT true NOT NULL,
	`targetTypes` text DEFAULT '["proxy_host","l4_proxy_host"]' NOT NULL,
	`operations` text DEFAULT '["create","update","delete","enable","disable"]' NOT NULL,
	`hostTags` text DEFAULT '[]' NOT NULL,
	`requiredApprovals` integer DEFAULT 1 NOT NULL,
	`allowEmergency` integer DEFAULT true NOT NULL,
	`timeZone` text DEFAULT 'UTC' NOT NULL,
	`windows` text DEFAULT '[]' NOT NULL,
	`requestTtlHours` integer DEFAULT 72 NOT NULL,
	`createdBy` integer,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `approval_policies_name_unique` ON `approval_policies` (`name`);
--> statement-breakpoint
CREATE TABLE `change_requests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`targetType` text NOT NULL,
	`targetId` integer,
	`targetName` text NOT NULL,
	`operation` text NOT NULL,
	`operations` text DEFAULT '[]' NOT NULL,
	`input` text NOT NULL,
	`baseState` text,
	`baseFingerprint` text,
	`tags` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`requiredApprovals` integer DEFAULT 1 NOT NULL,
	`policyIds` text DEFAULT '[]' NOT NULL,
	`policyNames` text DEFAULT '[]' NOT NULL,
	`note` text,
	`requestedBy` integer NOT NULL,
	`emergency` integer DEFAULT false NOT NULL,
	`emergencyReason` text,
	`emergencyBy` integer,
	`expiresAt` text NOT NULL,
	`decidedAt` text,
	`appliedAt` text,
	`appliedBy` integer,
	`error` text,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `change_requests_status_idx` ON `change_requests` (`status`,`id`);
--> statement-breakpoint
CREATE INDEX `change_requests_target_idx` ON `change_requests` (`targetType`,`targetId`);
--> statement-breakpoint
CREATE TABLE `change_request_reviews` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`requestId` integer NOT NULL,
	`userId` integer NOT NULL,
	`decision` text NOT NULL,
	`comment` text,
	`createdAt` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `change_request_reviews_request_idx` ON `change_request_reviews` (`requestId`,`id`);
