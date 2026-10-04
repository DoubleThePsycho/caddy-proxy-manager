-- API monetization, phase 2 (ee/monetization): postpaid consumers with a
-- saved card, credits for failed answers, x402 pay-per-request.
--
-- monetization_plans: billing (prepaid | postpaid), the postpaid hard cap and
-- charge threshold, the failed-answer credit option and whether key holders
-- may pay with x402.
-- monetization_consumers: a billing override, the consumer's Stripe Customer
-- and saved card (brand, last four and expiry for display), suspension, and
-- the last billed period.
-- monetization_hosts: x402 on the host and its price in US cents.
-- monetization_payments: Stripe payments (top-ups, off-session charges, open
-- amounts), written before Stripe is called so a crash is reconciled.
-- monetization_answer_credits: charge ids already credited back.
-- monetization_x402_payments: x402 payments, one per authorization nonce, with
-- the Stripe PaymentIntent that records each.
ALTER TABLE `monetization_plans` ADD `billing` text DEFAULT 'prepaid' NOT NULL;
--> statement-breakpoint
ALTER TABLE `monetization_plans` ADD `postpaidCapMicros` integer;
--> statement-breakpoint
ALTER TABLE `monetization_plans` ADD `postpaidThresholdMicros` integer;
--> statement-breakpoint
ALTER TABLE `monetization_plans` ADD `creditFailedAnswers` integer DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE `monetization_plans` ADD `acceptX402` integer DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE `monetization_consumers` ADD `billing` text;
--> statement-breakpoint
ALTER TABLE `monetization_consumers` ADD `stripeCustomerId` text;
--> statement-breakpoint
ALTER TABLE `monetization_consumers` ADD `paymentMethodId` text;
--> statement-breakpoint
ALTER TABLE `monetization_consumers` ADD `cardBrand` text;
--> statement-breakpoint
ALTER TABLE `monetization_consumers` ADD `cardLast4` text;
--> statement-breakpoint
ALTER TABLE `monetization_consumers` ADD `cardExpMonth` integer;
--> statement-breakpoint
ALTER TABLE `monetization_consumers` ADD `cardExpYear` integer;
--> statement-breakpoint
ALTER TABLE `monetization_consumers` ADD `suspendedAt` text;
--> statement-breakpoint
ALTER TABLE `monetization_consumers` ADD `suspendedReason` text;
--> statement-breakpoint
ALTER TABLE `monetization_consumers` ADD `billedPeriod` text;
--> statement-breakpoint
ALTER TABLE `monetization_hosts` ADD `x402Enabled` integer DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE `monetization_hosts` ADD `x402PriceCents` integer;
--> statement-breakpoint
CREATE TABLE `monetization_payments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`consumerId` integer NOT NULL,
	`kind` text NOT NULL,
	`reason` text,
	`status` text NOT NULL,
	`amountMicros` integer NOT NULL,
	`currency` text NOT NULL,
	`period` text,
	`idempotencyKey` text,
	`paymentMethodId` text,
	`paymentIntentId` text,
	`checkoutSessionId` text,
	`failureCode` text,
	`refundedMicros` integer DEFAULT 0 NOT NULL,
	`disputedMicros` integer DEFAULT 0 NOT NULL,
	`ledgerId` integer,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `monetization_payments_idempotency_key_unique` ON `monetization_payments` (`idempotencyKey`);
--> statement-breakpoint
CREATE UNIQUE INDEX `monetization_payments_payment_intent_unique` ON `monetization_payments` (`paymentIntentId`);
--> statement-breakpoint
CREATE UNIQUE INDEX `monetization_payments_checkout_session_unique` ON `monetization_payments` (`checkoutSessionId`);
--> statement-breakpoint
CREATE INDEX `monetization_payments_consumer_idx` ON `monetization_payments` (`consumerId`,`id`);
--> statement-breakpoint
CREATE INDEX `monetization_payments_status_idx` ON `monetization_payments` (`status`);
--> statement-breakpoint
CREATE TABLE `monetization_answer_credits` (
	`chargeId` text PRIMARY KEY NOT NULL,
	`consumerId` integer NOT NULL,
	`amountMicros` integer NOT NULL,
	`free` integer DEFAULT false NOT NULL,
	`createdAt` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `monetization_answer_credits_created_at_idx` ON `monetization_answer_credits` (`createdAt`);
--> statement-breakpoint
CREATE TABLE `monetization_x402_payments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`proxyHostId` integer NOT NULL,
	`consumerId` integer,
	`payer` text NOT NULL,
	`network` text NOT NULL,
	`asset` text NOT NULL,
	`amountMicros` integer NOT NULL,
	`nonceKey` text NOT NULL,
	`status` text NOT NULL,
	`transaction` text,
	`paymentIntentId` text,
	`recordAttempts` integer DEFAULT 0 NOT NULL,
	`errorReason` text,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `monetization_x402_payments_nonce_key_unique` ON `monetization_x402_payments` (`nonceKey`);
--> statement-breakpoint
CREATE UNIQUE INDEX `monetization_x402_payments_transaction_unique` ON `monetization_x402_payments` (`network`,`transaction`);
--> statement-breakpoint
CREATE UNIQUE INDEX `monetization_x402_payments_payment_intent_unique` ON `monetization_x402_payments` (`paymentIntentId`);
--> statement-breakpoint
CREATE INDEX `monetization_x402_payments_created_at_idx` ON `monetization_x402_payments` (`createdAt`);
--> statement-breakpoint
CREATE INDEX `monetization_x402_payments_payer_idx` ON `monetization_x402_payments` (`payer`);
