// SPDX-License-Identifier: Elastic-2.0
/**
 * What the Ask box shows before the first question: whether an AI provider,
 * the question settings and analytics allow asking. Never returns the
 * provider's key or address.
 */
import { isAnalyticsEnabled } from "@/src/lib/clickhouse/client";
import { getAiProviderConfig } from "@/ee/ai/settings";
import { getQuestionSettings } from "./settings";
import type { QuestionAvailability } from "./types";

const PROVIDER_NAMES: Record<string, string> = { anthropic: "Anthropic", openai_compatible: "OpenAI-compatible server" };

export async function getQuestionAvailability(): Promise<QuestionAvailability> {
  const [provider, settings] = await Promise.all([getAiProviderConfig().catch(() => null), getQuestionSettings()]);
  return {
    providerConfigured: provider !== null,
    enabled: settings.enabled,
    analyticsEnabled: isAnalyticsEnabled(),
    provider: provider ? { name: PROVIDER_NAMES[provider.provider] ?? provider.provider, model: provider.model } : null,
    settings,
  };
}
