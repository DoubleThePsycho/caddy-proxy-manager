// SPDX-License-Identifier: Elastic-2.0
/**
 * Turns enforced SSO off from the host, on SQLite or PostgreSQL: the way back
 * in when the identity provider is down and no break-glass account can sign
 * in (scripts/db/break-glass.ts, bundled into the image as
 * db-tools/break-glass.js; ee/docs/sso-enforcement.md). Safe to import from
 * client components.
 */
export const TURN_OFF_SSO_COMMAND = "docker compose exec web bun db-tools/break-glass.js turn-off-sso-enforcement";
