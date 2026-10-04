-- WAF tuning: rule exclusions as records. An exclusion skips one rule for the
-- global WAF settings (proxyHostId null) or one proxy host, optionally only
-- for a path (exact or prefix) and/or one variable, with a reason and who
-- added it. The excluded rule ids already stored in the "waf" setting and in
-- proxy host meta (waf.excluded_rule_ids) are copied in at start-up
-- (importLegacyWafExclusions), which stays idempotent; those lists keep
-- mirroring the whole-scope exclusions. Paranoia level, anomaly thresholds
-- and the over-the-limit action live in the "waf" setting.
CREATE TABLE `waf_rule_exclusions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ruleId` integer NOT NULL,
	`proxyHostId` integer,
	`pathMatch` text,
	`path` text,
	`variable` text,
	`reason` text DEFAULT '' NOT NULL,
	`createdBy` integer,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `waf_rule_exclusions_host_idx` ON `waf_rule_exclusions` (`proxyHostId`);
