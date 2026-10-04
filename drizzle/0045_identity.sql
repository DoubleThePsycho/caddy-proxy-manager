-- Identity: passkeys, the last sign-in of each account, API token scopes,
-- per-user interface preferences and the health of LDAP directories.

-- Passkeys (WebAuthn) for dashboard sign-in, Better Auth's passkey plugin
-- (model "passkey"). One row per credential: its public key, never a secret.
-- lastUsedAt is Ingressi's own column, written after a passkey sign-in.
CREATE TABLE `passkeys` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text,
	`publicKey` text NOT NULL,
	`userId` integer NOT NULL,
	`credentialID` text NOT NULL,
	`counter` integer DEFAULT 0 NOT NULL,
	`deviceType` text NOT NULL,
	`backedUp` integer DEFAULT false NOT NULL,
	`transports` text,
	`createdAt` text,
	`aaguid` text,
	`lastUsedAt` text,
	FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `passkeys_credential_id_unique` ON `passkeys` (`credentialID`);
--> statement-breakpoint
CREATE INDEX `passkeys_user_idx` ON `passkeys` (`userId`);
--> statement-breakpoint
-- When and how the account last completed a dashboard sign-in (password, sso,
-- saml, ldap or passkey). Null: it has not signed in since this release, or
-- ever (an "invited" account).
ALTER TABLE `users` ADD `lastSignInAt` text;
--> statement-breakpoint
ALTER TABLE `users` ADD `lastSignInMethod` text;
--> statement-breakpoint
-- Accounts that signed in before this release are not "invited": take the
-- latest completed sign-in from the audit log, or the newest session.
UPDATE `users` SET `lastSignInAt` = (
	SELECT MAX(`t`.`at`) FROM (
		SELECT `createdAt` AS `at` FROM `audit_events` WHERE `audit_events`.`userId` = `users`.`id` AND `audit_events`.`action` = 'login_success'
		UNION ALL
		SELECT `createdAt` AS `at` FROM `sessions` WHERE `sessions`.`userId` = `users`.`id`
	) AS `t`
);
--> statement-breakpoint
-- The permissions an API token is limited to: a JSON array of permission
-- names, intersected with its owner's on every request. Null: the owner's role.
ALTER TABLE `api_tokens` ADD `scopes` text;
--> statement-breakpoint
-- Interface preferences of each account (theme, time zone, number format).
CREATE TABLE `user_preferences` (
	`userId` integer PRIMARY KEY NOT NULL,
	`theme` text DEFAULT 'system' NOT NULL,
	`timeZone` text DEFAULT 'UTC' NOT NULL,
	`numberFormat` text DEFAULT 'en-US' NOT NULL,
	`updatedAt` text NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
-- The periodic connection check of each enabled LDAP directory (ee/ldap):
-- service account bind and a search of the user search base. No foreign key:
-- deleting a directory deletes its row explicitly.
CREATE TABLE `ldap_directory_health` (
	`directoryId` integer PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`checkedAt` text NOT NULL,
	`lastSuccessAt` text,
	`lastFailureAt` text,
	`failingSince` text,
	`lastError` text,
	`consecutiveFailures` integer DEFAULT 0 NOT NULL
);
