// SPDX-License-Identifier: Elastic-2.0
/**
 * @coinbase/cdp-sdk (loaded through @coinbase/x402 for the CDP facilitator's
 * JWT authentication) can send usage events and error reports, with their
 * message and stack, to Coinbase (https://cca-lite.coinbase.com/amp) unless
 * DISABLE_CDP_USAGE_TRACKING and DISABLE_CDP_ERROR_REPORTING are "true". The
 * part Ingressi loads (`@coinbase/cdp-sdk/auth`, which only signs JWTs) does
 * not load that module; these are set anyway, before the SDK is imported, so
 * that nothing the SDK adds later reports by default. An operator who sets
 * either variable keeps their value. The Docker image sets both too.
 */
process.env.DISABLE_CDP_USAGE_TRACKING ??= "true";
process.env.DISABLE_CDP_ERROR_REPORTING ??= "true";

export {};
