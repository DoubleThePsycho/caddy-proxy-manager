-- Multi-factor authentication for dashboard sign-in (Better Auth two-factor
-- plugin). users.twoFactorEnabled is the plugin's user field; two_factors
-- holds one row per enrolled account: the TOTP secret (encrypted by Better
-- Auth with SESSION_SECRET), the one-time backup codes (encrypted with
-- encryptSecret), and the sign-in lockout counters.
ALTER TABLE `users` ADD `twoFactorEnabled` integer DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE TABLE `two_factors` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`userId` integer NOT NULL,
	`secret` text NOT NULL,
	`backupCodes` text NOT NULL,
	`verified` integer DEFAULT true NOT NULL,
	`failedVerificationCount` integer DEFAULT 0 NOT NULL,
	`lockedUntil` text,
	FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `two_factors_user_unique` ON `two_factors` (`userId`);
