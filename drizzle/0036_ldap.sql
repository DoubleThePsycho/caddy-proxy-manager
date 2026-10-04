-- LDAP / Active Directory sign-in (ee, paid feature "ldap"): the directories
-- people sign in to the dashboard with. The service account password is
-- encrypted with encryptSecret. Accounts signed in through a directory are
-- `accounts` rows with providerId "ldap:<id>".
CREATE TABLE `ldap_directories` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`url` text NOT NULL,
	`startTls` integer DEFAULT false NOT NULL,
	`allowUnencrypted` integer DEFAULT false NOT NULL,
	`caCertificate` text,
	`connectTimeoutMs` integer DEFAULT 5000 NOT NULL,
	`operationTimeoutMs` integer DEFAULT 10000 NOT NULL,
	`bindDn` text NOT NULL,
	`bindPassword` text NOT NULL,
	`userSearchBase` text NOT NULL,
	`userSearchFilter` text NOT NULL,
	`usernameAttribute` text DEFAULT 'uid' NOT NULL,
	`emailAttribute` text DEFAULT 'mail' NOT NULL,
	`displayNameAttribute` text DEFAULT 'cn' NOT NULL,
	`uniqueIdAttribute` text DEFAULT 'entryUUID' NOT NULL,
	`groupMode` text DEFAULT 'none' NOT NULL,
	`groupMembershipAttribute` text DEFAULT 'memberOf' NOT NULL,
	`groupSearchBase` text,
	`groupSearchFilter` text,
	`nestedGroups` integer DEFAULT false NOT NULL,
	`groupRoleMappings` text DEFAULT '[]' NOT NULL,
	`defaultRole` text DEFAULT 'user' NOT NULL,
	`requiredGroup` text,
	`provisionUsers` integer DEFAULT false NOT NULL,
	`linkExistingAccounts` integer DEFAULT false NOT NULL,
	`allowWhenSsoEnforced` integer DEFAULT false NOT NULL,
	`createdBy` integer,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ldap_directories_name_unique` ON `ldap_directories` (`name`);
