-- Shared runtime state: what a web process kept in memory and several
-- replicas on one PostgreSQL database must share (src/lib/db/README.md,
-- "Events and shared state"). On SQLite there is one process and the
-- application keeps using memory, so these tables stay empty there; they
-- exist on both so the schemas match.
--
-- rate_limit_counters: the counters of the request and login rate limiters
-- (src/lib/rate-limit.ts), by "<limiter>:<key>". Times are milliseconds
-- since the epoch; `held` counts attempts in progress until `heldUntilMs`.
--
-- auth_rate_limits: Better Auth's request rate limits (its "database"
-- storage; Better Auth names the columns).
--
-- shared_runtime_entries: short-lived values one request leaves for a later
-- one (how a sign-in waiting for its second factor started, used TOTP
-- codes), by "<scope>:<key>", with an ISO 8601 expiry.
--
-- Expired rows are pruned by a background job.
CREATE TABLE `rate_limit_counters` (
	`bucket` text PRIMARY KEY NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`windowStartMs` integer NOT NULL,
	`blockedUntilMs` integer DEFAULT 0 NOT NULL,
	`held` integer DEFAULT 0 NOT NULL,
	`heldUntilMs` integer DEFAULT 0 NOT NULL,
	`expiresAtMs` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `rate_limit_counters_expires_idx` ON `rate_limit_counters` (`expiresAtMs`);
--> statement-breakpoint
CREATE TABLE `auth_rate_limits` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`key` text NOT NULL,
	`count` integer NOT NULL,
	`lastRequest` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_rate_limits_key_unique` ON `auth_rate_limits` (`key`);
--> statement-breakpoint
CREATE INDEX `auth_rate_limits_last_request_idx` ON `auth_rate_limits` (`lastRequest`);
--> statement-breakpoint
CREATE TABLE `shared_runtime_entries` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`expiresAt` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `shared_runtime_entries_expires_idx` ON `shared_runtime_entries` (`expiresAt`);
