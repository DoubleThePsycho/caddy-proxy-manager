// SPDX-License-Identifier: Elastic-2.0
/**
 * License checks for setting up and changing alerting.
 *
 * Community carve-out: e-mail channels, and certificate-expiry rules that only
 * notify e-mail channels, can be created and changed without a license.
 * Creating, enabling or changing anything else needs "alerting"; turning AI
 * explanations on needs "ai_analyst".
 *
 * Winding down never needs a license: deleting a channel or rule, a change
 * that only disables something ({"enabled": false}, {"explain": false}) and
 * removing the AI provider always work, so a lapsed install can switch a paid
 * feature off. Nothing here runs when alerts are evaluated or delivered:
 * configured alerts keep working with an expired or removed key.
 */
import { isFeatureConfigurable, requireFeature } from "@/ee/licensing/store";
import { FREE_CHANNEL_TYPES, FREE_RULE_TYPES, type ChannelType, type RuleType } from "./types";

export function isFreeChannelType(type: ChannelType): boolean {
  return FREE_CHANNEL_TYPES.includes(type);
}

/** Whether a rule is covered by the Community carve-out. */
export function isFreeRule(type: RuleType, channelTypes: readonly ChannelType[]): boolean {
  return FREE_RULE_TYPES.includes(type) && channelTypes.every(isFreeChannelType);
}

export async function requireChannelLicense(type: ChannelType): Promise<void> {
  if (!isFreeChannelType(type)) await requireFeature("alerting");
}

export async function requireRuleLicense(type: RuleType, channelTypes: readonly ChannelType[]): Promise<void> {
  if (!isFreeRule(type, channelTypes)) await requireFeature("alerting");
}

/**
 * True when `record` only turns things off: every field it sets is one of
 * `offValues` with exactly that value (e.g. {"enabled": false}).
 */
export function isWindDownOnly(record: Record<string, unknown>, offValues: Record<string, unknown>): boolean {
  const keys = Object.keys(record);
  return keys.length > 0 && keys.every((key) => key in offValues && record[key] === offValues[key]);
}

export type AlertingLicenseView = { alerting: boolean; aiAnalyst: boolean };

/** What the dashboard may offer to change (read-only views never depend on this). */
export async function getAlertingLicenseView(): Promise<AlertingLicenseView> {
  const [alerting, aiAnalyst] = await Promise.all([
    isFeatureConfigurable("alerting"),
    isFeatureConfigurable("ai_analyst"),
  ]);
  return { alerting, aiAnalyst };
}
