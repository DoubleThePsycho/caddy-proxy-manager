// SPDX-License-Identifier: Elastic-2.0
"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/src/lib/auth";
import { ApiClientError } from "@/src/lib/api-errors";
import { deleteBrandingAsset, resetBranding, updateBranding, uploadBrandingAsset } from "@/ee/white-label/service";
import { parseBrandingInput } from "@/ee/white-label/validation";
import { readUploadForm } from "@/ee/white-label/http";
import { assetKindFromSlug, type AssetKind, type BrandingView } from "@/ee/white-label/types";

export type BrandingActionResult = { ok: true; view: BrandingView } | { ok: false; error: string };

/** Every page shows the branding: the whole layout is revalidated after a change. */
async function settle(change: () => Promise<BrandingView>): Promise<BrandingActionResult> {
  try {
    const view = await change();
    revalidatePath("/", "layout");
    return { ok: true, view };
  } catch (error) {
    if (error instanceof ApiClientError) return { ok: false, error: error.message };
    throw error;
  }
}

function assetKind(slug: string): AssetKind {
  const kind = assetKindFromSlug(slug);
  if (!kind) throw new ApiClientError("Unknown asset", 404);
  return kind;
}

export async function saveBrandingAction(input: unknown): Promise<BrandingActionResult> {
  const session = await requirePermission("branding:write");
  return settle(async () => updateBranding(parseBrandingInput(input), Number(session.user.id)));
}

export async function uploadBrandingAssetAction(asset: string, form: FormData): Promise<BrandingActionResult> {
  const session = await requirePermission("branding:write");
  return settle(async () => uploadBrandingAsset(assetKind(asset), await readUploadForm(form), Number(session.user.id)));
}

export async function deleteBrandingAssetAction(asset: string): Promise<BrandingActionResult> {
  const session = await requirePermission("branding:write");
  return settle(async () => deleteBrandingAsset(assetKind(asset), Number(session.user.id)));
}

export async function resetBrandingAction(): Promise<BrandingActionResult> {
  const session = await requirePermission("branding:write");
  return settle(async () => resetBranding(Number(session.user.id)));
}
