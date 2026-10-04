// SPDX-License-Identifier: Elastic-2.0
/**
 * AI provider used by the AI analyst (ee). Stored in the settings table under
 * "ai_provider", with the API key encrypted. Not synced to slave instances:
 * alerts, and their explanations, are produced on the node that evaluates them.
 */
import { clearSetting, getSetting, setSetting } from "@/src/lib/settings";
import { decryptSecret, encryptSecret } from "@/src/lib/secret";
import { logAuditEvent } from "@/src/lib/audit";
import { ApiValidationError } from "@/src/lib/api-errors";
import { requireFeature } from "@/ee/licensing/store";
import { isWindDownOnly } from "@/ee/alerting/gate";
import {
  isPlainObject,
  readBoolean,
  readHttpUrl,
  readSecretInput,
  readText,
  rejectUnknownKeys,
  requireObject,
} from "@/ee/alerting/validation";

export const AI_SETTINGS_KEY = "ai_provider";
export const AI_PROVIDERS = ["anthropic", "openai_compatible"] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];
export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-5";
/** Only this endpoint ever receives an Anthropic API key. */
export const ANTHROPIC_API_URL = "https://api.anthropic.com";

type StoredAiSettings = {
  enabled: boolean;
  provider: AiProvider;
  model: string;
  /** encryptSecret() output */
  apiKey?: string;
  /** openai_compatible only, without trailing slash, e.g. http://ollama:11434/v1 */
  baseUrl?: string;
};

export type AiSettingsView = {
  enabled: boolean;
  provider: AiProvider | null;
  model: string | null;
  baseUrl: string | null;
  hasApiKey: boolean;
  /** Enabled and complete: alert explanations will be requested. */
  configured: boolean;
  defaultModel: string;
};

/** Decrypted settings for a model call; never returned by the API. */
export type ResolvedAiProvider = {
  provider: AiProvider;
  model: string;
  apiKey: string | null;
  baseUrl: string | null;
};

function isProvider(value: unknown): value is AiProvider {
  return typeof value === "string" && (AI_PROVIDERS as readonly string[]).includes(value);
}

async function readStored(): Promise<StoredAiSettings | null> {
  const value = await getSetting<unknown>(AI_SETTINGS_KEY);
  if (!isPlainObject(value) || !isProvider(value.provider) || typeof value.model !== "string") return null;
  return {
    enabled: value.enabled === true,
    provider: value.provider,
    model: value.model,
    apiKey: typeof value.apiKey === "string" && value.apiKey ? value.apiKey : undefined,
    baseUrl: typeof value.baseUrl === "string" && value.baseUrl ? value.baseUrl : undefined,
  };
}

function isComplete(settings: StoredAiSettings): boolean {
  if (!settings.model) return false;
  return settings.provider === "anthropic" ? Boolean(settings.apiKey) : Boolean(settings.baseUrl);
}

function toView(settings: StoredAiSettings | null): AiSettingsView {
  return {
    enabled: settings?.enabled ?? false,
    provider: settings?.provider ?? null,
    model: settings?.model ?? null,
    baseUrl: settings?.provider === "openai_compatible" ? settings.baseUrl ?? null : null,
    hasApiKey: Boolean(settings?.apiKey),
    configured: Boolean(settings?.enabled && isComplete(settings)),
    defaultModel: DEFAULT_ANTHROPIC_MODEL,
  };
}

export async function getAiSettingsView(): Promise<AiSettingsView> {
  return toView(await readStored());
}

function readModel(value: unknown): string {
  const model = readText(value, "model", 200);
  if (!/^[A-Za-z0-9._:/@+-]+$/.test(model)) throw new ApiValidationError("model contains invalid characters");
  return model;
}

/** Removes the provider and its key. Winding down: never needs a license. */
export async function clearAiSettings(actorUserId: number): Promise<AiSettingsView> {
  const previous = await readStored();
  await clearSetting(AI_SETTINGS_KEY);
  if (previous) {
    await logAuditEvent({
      userId: actorUserId,
      action: "ai_settings_removed",
      entityType: "ai_settings",
      summary: `Removed the AI provider (${previous.provider}, ${previous.model})`,
      data: { provider: previous.provider, model: previous.model },
    });
  }
  return toView(null);
}

/**
 * Validates and stores the provider settings. Needs the ai_analyst feature,
 * except to wind down: {"provider": null} removes the provider, and
 * {"enabled": false} and/or {"apiKey": null} switch it off.
 */
export async function saveAiSettings(body: unknown, actorUserId: number): Promise<AiSettingsView> {
  const record = requireObject(body, "Request body");
  if (record.provider === null) {
    rejectUnknownKeys(record, ["provider"], "a request that removes the AI provider");
    return clearAiSettings(actorUserId);
  }
  if (!isWindDownOnly(record, { enabled: false, apiKey: null })) await requireFeature("ai_analyst");
  rejectUnknownKeys(record, ["enabled", "provider", "model", "apiKey", "baseUrl"], "the AI settings");
  const previous = await readStored();
  if (!previous && isWindDownOnly(record, { enabled: false, apiKey: null })) return toView(null);

  const provider = record.provider !== undefined ? record.provider : previous?.provider;
  if (!isProvider(provider)) throw new ApiValidationError(`provider must be one of: ${AI_PROVIDERS.join(", ")}`);
  const providerChanged = previous !== null && previous.provider !== provider;

  const model =
    record.model !== undefined && record.model !== null && record.model !== ""
      ? readModel(record.model)
      : !providerChanged && previous?.model
        ? previous.model
        : provider === "anthropic"
          ? DEFAULT_ANTHROPIC_MODEL
          : readModel(record.model);

  let baseUrl: string | undefined;
  if (provider === "openai_compatible") {
    const raw = record.baseUrl !== undefined ? record.baseUrl : providerChanged ? undefined : previous?.baseUrl;
    baseUrl = readHttpUrl(raw, "baseUrl").replace(/\/+$/, "");
  } else if (record.baseUrl !== undefined && record.baseUrl !== null && record.baseUrl !== "") {
    throw new ApiValidationError("baseUrl is only used by the openai_compatible provider");
  }

  // The key may only go to the destination it was entered for.
  const destinationChanged = providerChanged || (previous !== null && (previous.baseUrl ?? undefined) !== baseUrl);
  const keyInput = readSecretInput(record.apiKey, "apiKey", 1024);
  let apiKey: string | undefined;
  if (keyInput.kind === "set") {
    apiKey = encryptSecret(keyInput.value);
  } else if (keyInput.kind === "keep" && previous?.apiKey) {
    if (destinationChanged) {
      throw new ApiValidationError("Enter the API key again when changing the provider or base URL, or send null to remove it");
    }
    apiKey = previous.apiKey;
  }

  const enabled = readBoolean(record.enabled, "enabled", previous?.enabled ?? true);
  if (enabled && provider === "anthropic" && !apiKey) throw new ApiValidationError("apiKey is required for the anthropic provider");

  const next: StoredAiSettings = { enabled, provider, model, ...(apiKey ? { apiKey } : {}), ...(baseUrl ? { baseUrl } : {}) };
  await setSetting(AI_SETTINGS_KEY, next);
  await logAuditEvent({
    userId: actorUserId,
    action: "ai_settings_updated",
    entityType: "ai_settings",
    summary: `Updated the AI provider (${provider}, ${model}${enabled ? "" : ", disabled"})`,
    data: { enabled, provider, model, baseUrl: baseUrl ?? null, apiKeyChanged: keyInput.kind !== "keep" },
  });
  return toView(next);
}

/** The provider to call, or null when none is enabled and complete. Never checks the license. */
export async function getAiProviderConfig(): Promise<ResolvedAiProvider | null> {
  const settings = await readStored();
  if (!settings?.enabled || !isComplete(settings)) return null;
  let apiKey: string | null = null;
  if (settings.apiKey) {
    try {
      apiKey = decryptSecret(settings.apiKey, "AI provider API key");
    } catch {
      return null;
    }
  }
  return {
    provider: settings.provider,
    model: settings.model,
    apiKey,
    baseUrl: settings.provider === "openai_compatible" ? settings.baseUrl ?? null : ANTHROPIC_API_URL,
  };
}
