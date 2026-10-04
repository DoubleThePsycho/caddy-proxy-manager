"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/src/lib/auth";
import { ApiClientError } from "@/src/lib/api-errors";
import { CaddyApplyError } from "@/src/lib/caddy-apply-error";
import {
  addBlockedSource,
  createAccessList,
  deleteAccessList,
  ensureBlockedSourcesList,
  removeBlockedSource,
  saveAccessList,
  type AccessList,
  type AccessListInput,
  type AccessListRule,
  type AccessListSave,
  type BlockedSourceInput,
} from "@/src/lib/models/access-lists";
import { assertProviderLevel } from "@/ee/multi-tenancy/scope";
import { dashboardCreateOrganization } from "@/ee/multi-tenancy/view";

// The models answer "not found" for a list of another organisation (ee/multi-tenancy).

/** `saved` is true when the change was stored but Caddy did not take the new configuration. */
export type AccessListActionResult<T> = { ok: true; value: T } | { ok: false; error: string; saved?: boolean };

const PROVIDER_ONLY = "The Blocked sources list applies to every organisation; only provider-level users can change it";

/** Client-safe failures come back as { ok: false }; anything else is thrown. */
async function run<T>(operation: () => Promise<T>): Promise<AccessListActionResult<T>> {
  try {
    const value = await operation();
    revalidatePath("/access-lists");
    return { ok: true, value };
  } catch (error) {
    if (error instanceof ApiClientError) return { ok: false, error: error.message };
    if (error instanceof CaddyApplyError) {
      revalidatePath("/access-lists");
      return { ok: false, saved: true, error: `Saved, but Caddy did not take the new configuration: ${error.message}` };
    }
    if (error instanceof Error && error.message.toLowerCase().endsWith("not found")) {
      return { ok: false, error: error.message };
    }
    throw error;
  }
}

export async function createAccessListAction(input: AccessListInput): Promise<AccessListActionResult<AccessList>> {
  const session = await requirePermission("access_lists:write");
  const userId = Number(session.user.id);
  return run(async () =>
    createAccessList(
      {
        ...input,
        // A provider-level user looking at one organisation creates it there.
        organizationId: await dashboardCreateOrganization(session.access),
      },
      userId
    )
  );
}

/** The editor's save: settings, every rule in order and member changes, applied once. */
export async function saveAccessListAction(id: number, input: AccessListSave): Promise<AccessListActionResult<AccessList>> {
  const session = await requirePermission("access_lists:write");
  const userId = Number(session.user.id);
  return run(() => saveAccessList(id, input, userId));
}

export async function deleteAccessListAction(id: number): Promise<AccessListActionResult<null>> {
  const session = await requirePermission("access_lists:write");
  const userId = Number(session.user.id);
  return run(async () => {
    await deleteAccessList(id, userId);
    return null;
  });
}

/** Saves the global Blocked sources list (created on first use). */
export async function saveBlockedSourcesAction(input: AccessListSave): Promise<AccessListActionResult<AccessList>> {
  const session = await requirePermission("access_lists:write");
  const userId = Number(session.user.id);
  return run(async () => {
    assertProviderLevel(session.access, PROVIDER_ONLY);
    const list = await ensureBlockedSourcesList(userId);
    return saveAccessList(list.id, input, userId);
  });
}

/**
 * Blocks an address (or network, country, continent, AS number) on every
 * host: the Security events page's Block button.
 */
export async function blockSourceAction(input: BlockedSourceInput): Promise<AccessListActionResult<AccessListRule>> {
  const session = await requirePermission("access_lists:write");
  const userId = Number(session.user.id);
  return run(async () => {
    assertProviderLevel(session.access, PROVIDER_ONLY);
    return (await addBlockedSource(input, userId)).entry;
  });
}

export async function unblockSourceAction(entryId: number): Promise<AccessListActionResult<null>> {
  const session = await requirePermission("access_lists:write");
  const userId = Number(session.user.id);
  return run(async () => {
    assertProviderLevel(session.access, PROVIDER_ONLY);
    await removeBlockedSource(entryId, userId);
    return null;
  });
}
