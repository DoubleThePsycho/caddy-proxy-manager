// SPDX-License-Identifier: Elastic-2.0
/**
 * What the Ask box shows before the first question: whether the license,
 * an AI provider, the question settings and analytics allow asking. Never
 * returns the provider's key or address.
 */
import { isAnalyticsEnabled } from "@/src/lib/clickhouse/client";
import { isFeatureConfigurable } from "@/ee/licensing/store";
import { getAiProviderConfig } from "@/ee/ai/settings";
import { getQuestionSettings } from "./settings";
import type { QuestionAvailability } from "./types";

const PROVIDER_NAMES: Record<string, string> = { anthropic: "Anthropic", openai_compatible: "OpenAI-compatible server" };

export async function getQuestionAvailability(): Promise<QuestionAvailability> {
  const [licensed, provider, settings] = await Promise.all([
    isFeatureConfigurable("ai_analyst"),
    getAiProviderConfig().catch(() => null),
    getQuestionSettings(),
  ]);
  return {
    licensed,
    providerConfigured: provider !== null,
    enabled: settings.enabled,
    analyticsEnabled: isAnalyticsEnabled(),
    provider: provider ? { name: PROVIDER_NAMES[provider.provider] ?? provider.provider, model: provider.model } : null,
    settings,
  };
}
