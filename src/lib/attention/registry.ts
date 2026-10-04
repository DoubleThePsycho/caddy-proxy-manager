/**
 * The attention providers and how their items are collected for a reader.
 * Each provider runs only when the reader holds one of its permissions (and,
 * for organisation users, only when it filters to their organisation), with
 * its own time limit; a provider that fails or is slow is reported as such
 * and never hides the others. Items come back most severe first, then
 * newest first.
 */
import { can, tenantOf, type Access } from "@/src/lib/permissions";
import type { AttentionItem, AttentionProvider, AttentionSeverity, AttentionSourceStatus, AttentionView } from "./types";

export const ATTENTION_PROVIDER_TIMEOUT_MS = 4_000;
export const MAX_ATTENTION_ITEMS = 50;
const MAX_TEXT = 500;

const store = globalThis as typeof globalThis & { __ingressiAttentionProviders?: Map<string, AttentionProvider> };
const providers = (store.__ingressiAttentionProviders ??= new Map<string, AttentionProvider>());

/** Registers (or replaces) a provider by its id. */
export function registerAttentionProvider(provider: AttentionProvider): void {
  providers.set(provider.id, provider);
}

export function unregisterAttentionProvider(id: string): void {
  providers.delete(id);
}

export function listAttentionProviders(): AttentionProvider[] {
  return [...providers.values()];
}

/** Whether `access` may see the provider's items. */
export function mayRead(provider: AttentionProvider, access: Access): boolean {
  if (tenantOf(access) !== null && !provider.organizationAware) return false;
  return provider.permissions.length === 0 || provider.permissions.some((permission) => can(access, permission));
}

const RANK: Record<AttentionSeverity, number> = { critical: 0, warning: 1, info: 2 };

function clean(text: string): string {
  return text.replace(/\p{Cc}+/gu, " ").slice(0, MAX_TEXT);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), ms);
      (timer as { unref?: () => void }).unref?.();
    }),
  ]);
}

/** The items `access` may see, from every registered provider. */
export async function collectAttention(access: Access, options: { now?: Date; timeoutMs?: number } = {}): Promise<AttentionView> {
  const now = options.now ?? new Date();
  const readable = listAttentionProviders().filter((provider) => mayRead(provider, access));
  const sources: AttentionSourceStatus[] = [];
  const results = await Promise.all(
    readable.map(async (provider) => {
      try {
        const result = await withTimeout(provider.collect({ access, now }), options.timeoutMs ?? ATTENTION_PROVIDER_TIMEOUT_MS);
        if (result === "timeout") {
          sources.push({ id: provider.id, label: provider.label, status: "timeout", items: 0 });
          return [];
        }
        sources.push({ id: provider.id, label: provider.label, status: "ok", items: result.length });
        return result.map((item): AttentionItem => ({
          ...item,
          source: provider.id,
          title: clean(item.title),
          detail: clean(item.detail),
          actions: item.actions.slice(0, 3),
        }));
      } catch {
        sources.push({ id: provider.id, label: provider.label, status: "error", items: 0 });
        return [];
      }
    })
  );
  const items = results.flat().sort((a, b) => RANK[a.severity] - RANK[b.severity] || (b.at ?? "").localeCompare(a.at ?? ""));
  const counts: Record<AttentionSeverity, number> = { critical: 0, warning: 0, info: 0 };
  for (const item of items) counts[item.severity] += 1;
  return {
    generatedAt: now.toISOString(),
    items: items.slice(0, MAX_ATTENTION_ITEMS),
    truncated: items.length > MAX_ATTENTION_ITEMS,
    counts,
    sources: sources.sort((a, b) => a.id.localeCompare(b.id)),
  };
}
