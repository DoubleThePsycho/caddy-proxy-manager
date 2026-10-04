-- API monetization (ee/monetization): plans, consumers, consumer API keys,
-- the balance ledger and per-host settings. Amounts are integer micro-units of
-- the install's currency (1 USD = 1,000,000).
CREATE TABLE `monetization_plans` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`pricePerRequestMicros` integer DEFAULT 0 NOT NULL,
	`includedRequestsPerMonth` integer DEFAULT 0 NOT NULL,
	`requestsPerMinute` integer,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `monetization_plans_name_unique` ON `monetization_plans` (`name`);
--> statement-breakpoint
CREATE TABLE `monetization_consumers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`email` text,
	`status` text DEFAULT 'active' NOT NULL,
	`planId` integer,
	`balanceMicros` integer DEFAULT 0 NOT NULL,
	`overdraftAllowanceMicros` integer DEFAULT 0 NOT NULL,
	`freeUsageMonth` text,
	`freeUsageCount` integer DEFAULT 0 NOT NULL,
	`portalTokenHash` text,
	`createdBy` integer,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `monetization_consumers_portal_token_unique` ON `monetization_consumers` (`portalTokenHash`);
--> statement-breakpoint
CREATE INDEX `monetization_consumers_plan_idx` ON `monetization_consumers` (`planId`);
--> statement-breakpoint
CREATE TABLE `monetization_keys` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`consumerId` integer NOT NULL,
	`name` text,
	`prefix` text NOT NULL,
	`keyHash` text NOT NULL,
	`createdAt` text NOT NULL,
	`lastUsedAt` text,
	`revokedAt` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `monetization_keys_prefix_unique` ON `monetization_keys` (`prefix`);
--> statement-breakpoint
CREATE UNIQUE INDEX `monetization_keys_key_hash_unique` ON `monetization_keys` (`keyHash`);
--> statement-breakpoint
CREATE INDEX `monetization_keys_consumer_idx` ON `monetization_keys` (`consumerId`);
--> statement-breakpoint
CREATE TABLE `monetization_ledger` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`consumerId` integer NOT NULL,
	`type` text NOT NULL,
	`amountMicros` integer NOT NULL,
	`balanceAfterMicros` integer NOT NULL,
	`requests` integer DEFAULT 0 NOT NULL,
	`freeRequests` integer DEFAULT 0 NOT NULL,
	`externalReference` text,
	`description` text,
	`createdBy` integer,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `monetization_ledger_external_reference_unique` ON `monetization_ledger` (`externalReference`);
--> statement-breakpoint
CREATE INDEX `monetization_ledger_consumer_idx` ON `monetization_ledger` (`consumerId`,`id`);
--> statement-breakpoint
CREATE INDEX `monetization_ledger_created_at_idx` ON `monetization_ledger` (`createdAt`);
--> statement-breakpoint
CREATE TABLE `monetization_hosts` (
	`proxyHostId` integer PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`keyHeader` text DEFAULT 'Authorization' NOT NULL,
	`allowedPlanIds` text DEFAULT '[]' NOT NULL,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL
);
