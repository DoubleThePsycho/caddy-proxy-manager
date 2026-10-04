-- AI analyst (ee): WAF tuning suggestions and the dismissals and applications recorded on them.
CREATE TABLE `waf_tuning_suggestions` (
	`id` text PRIMARY KEY NOT NULL,
	`host` text NOT NULL,
	`ruleId` integer NOT NULL,
	`proxyHostId` integer NOT NULL,
	`status` text NOT NULL,
	`confidence` text NOT NULL,
	`score` integer NOT NULL,
	`data` text NOT NULL,
	`explanation` text,
	`generatedAt` text NOT NULL,
	`decidedAt` text,
	`decidedBy` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `waf_tuning_suggestions_host_rule_unique` ON `waf_tuning_suggestions` (`host`,`ruleId`);
--> statement-breakpoint
CREATE INDEX `waf_tuning_suggestions_status_idx` ON `waf_tuning_suggestions` (`status`);
