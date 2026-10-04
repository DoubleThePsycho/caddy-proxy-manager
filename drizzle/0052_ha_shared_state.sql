-- High availability shared state (ee/high-availability/shared-state).
--
-- With shared state on, API monetization balances and usage counters live in
-- Redis or Valkey, and the leader writes them back to the ledger every few
-- seconds. These two tables make that write-back idempotent: each is updated
-- in the same transaction as the ledger rows it accounts for.
--
-- monetization_shared_cursors: per consumer, how much of the cumulative usage
-- counters of the shared hash is already in the ledger. The counters restart
-- with a new epoch when the hash is created again.
--
-- monetization_shared_credits: every top-up or adjustment taken from a
-- consumer's shared credit queue, by its id, so none is written twice;
-- ledgerId is null when its reference was already in the ledger.
--
-- consumerId is not a foreign key; deleting a consumer deletes its cursor
-- explicitly and keeps its credits, like its ledger rows.
CREATE TABLE `monetization_shared_cursors` (
	`consumerId` integer PRIMARY KEY NOT NULL,
	`epoch` text NOT NULL,
	`chargedMicros` integer DEFAULT 0 NOT NULL,
	`requests` integer DEFAULT 0 NOT NULL,
	`freeRequests` integer DEFAULT 0 NOT NULL,
	`updatedAt` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `monetization_shared_credits` (
	`creditId` text PRIMARY KEY NOT NULL,
	`consumerId` integer NOT NULL,
	`ledgerId` integer,
	`createdAt` text NOT NULL
);
