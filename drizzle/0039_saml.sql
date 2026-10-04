-- SAML 2.0 single sign-on (ee, paid feature "sso_saml"): identity providers,
-- their group-to-role mappings, sign-ins in progress (AuthnRequest ID and
-- browser binding) and used assertion IDs (replay protection). The SP
-- signing key is encrypted with encryptSecret. Accounts signed in through a
-- provider are `accounts` rows with providerId "saml:<id>".
CREATE TABLE `saml_providers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`idpEntityId` text NOT NULL,
	`idpSsoUrl` text NOT NULL,
	`idpCertificates` text NOT NULL,
	`spPrivateKey` text,
	`spCertificate` text,
	`subjectAttribute` text,
	`emailAttribute` text DEFAULT 'email' NOT NULL,
	`nameAttribute` text,
	`groupsAttribute` text,
	`defaultRole` text DEFAULT 'user' NOT NULL,
	`requiredGroup` text,
	`provisionUsers` integer DEFAULT false NOT NULL,
	`linkExistingAccounts` integer DEFAULT false NOT NULL,
	`createdBy` integer,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `saml_providers_name_unique` ON `saml_providers` (`name`);
--> statement-breakpoint
CREATE TABLE `saml_group_roles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`providerId` integer NOT NULL,
	`groupValue` text NOT NULL,
	`role` text NOT NULL,
	`createdAt` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `saml_group_roles_provider_group_unique` ON `saml_group_roles` (`providerId`,`groupValue`);
--> statement-breakpoint
CREATE TABLE `saml_requests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`providerId` integer NOT NULL,
	`requestId` text NOT NULL,
	`bindingHash` text NOT NULL,
	`callbackUrl` text NOT NULL,
	`createdAt` text NOT NULL,
	`expiresAt` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `saml_requests_request_id_unique` ON `saml_requests` (`requestId`);
--> statement-breakpoint
CREATE UNIQUE INDEX `saml_requests_binding_unique` ON `saml_requests` (`bindingHash`);
--> statement-breakpoint
CREATE INDEX `saml_requests_expires_idx` ON `saml_requests` (`expiresAt`);
--> statement-breakpoint
CREATE TABLE `saml_used_assertions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`providerId` integer NOT NULL,
	`assertionId` text NOT NULL,
	`expiresAt` text NOT NULL,
	`createdAt` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `saml_used_assertions_unique` ON `saml_used_assertions` (`providerId`,`assertionId`);
--> statement-breakpoint
CREATE INDEX `saml_used_assertions_expires_idx` ON `saml_used_assertions` (`expiresAt`);
