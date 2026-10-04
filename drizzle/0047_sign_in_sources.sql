-- Sign-in activity by source.
--
-- The newest completed dashboard sign-in through each identity provider,
-- keyed like accounts.providerId: an OIDC provider's id, "saml:<id>" or
-- "ldap:<id>". Written by src/lib/sign-in-activity.ts when a sign-in
-- completes; lastUserId is not a foreign key, so a deleted account leaves
-- the time behind without a name.
CREATE TABLE `sign_in_sources` (
	`providerId` text PRIMARY KEY NOT NULL,
	`lastSignInAt` text NOT NULL,
	`lastUserId` integer
);
--> statement-breakpoint
-- When an account was disabled, null while it is not. The triggers keep it
-- whichever way the status changes (dashboard, REST API, SCIM, access
-- reviews, imports). Accounts disabled before this migration have none:
-- their audit records do not say it reliably.
ALTER TABLE `users` ADD `disabledAt` text;
--> statement-breakpoint
CREATE TRIGGER `users_disabled_at_insert` AFTER INSERT ON `users`
WHEN NEW.`status` = 'disabled' AND NEW.`disabledAt` IS NULL
BEGIN
	UPDATE `users` SET `disabledAt` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE `id` = NEW.`id`;
END;
--> statement-breakpoint
CREATE TRIGGER `users_disabled_at_update` AFTER UPDATE OF `status` ON `users`
WHEN NEW.`status` IS NOT OLD.`status`
BEGIN
	UPDATE `users`
	SET `disabledAt` = CASE WHEN NEW.`status` = 'disabled' THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') END
	WHERE `id` = NEW.`id`;
END;
