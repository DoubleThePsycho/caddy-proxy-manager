// SPDX-License-Identifier: Elastic-2.0
/**
 * White-label (feature "white_label", Enterprise edition): reading and
 * changing the branding.
 *
 * Setting a field to a value of your own and uploading a logo or favicon
 * need a license that includes the feature (requireFeature). Restoring a
 * field to its default, removing an asset, resetting everything and reading
 * never do, and nothing on the request path checks the license, so branding
 * that is already configured keeps showing when a license lapses.
 */
import { ApiValidationError } from "@/src/lib/api-errors";
import { appDb } from "@/src/lib/db";
import { logAuditEvent } from "@/src/lib/audit";
import { syncInstances } from "@/src/lib/instance-sync";
import { BRAND_NAME } from "@/src/lib/brand";
import { isFeatureConfigurable, requireFeature } from "@/ee/licensing/store";
import { checkDeclaredFile, sanitizeImage } from "./images";
import { fieldsNeedingLicense } from "./validation";
import { assetUrl, clearBranding, getBranding, loadBranding, loadedAsset, writeBranding, type Branding } from "./store";
import {
  ASSET_KINDS,
  ASSET_LABELS,
  ASSET_LIMITS,
  MAX_ASSET_BYTES,
  WHITE_LABEL_FEATURE,
  type AssetKind,
  type AssetView,
  type BrandingInput,
  type BrandingSettings,
  type BrandingView,
} from "./types";

function assetViews(branding: Branding): Record<AssetKind, AssetView | null> {
  const views = { logoLight: null, logoDark: null, favicon: null } as Record<AssetKind, AssetView | null>;
  for (const kind of ASSET_KINDS) {
    const asset = branding.assets[kind];
    if (asset) {
      views[kind] = { type: asset.type, width: asset.width, height: asset.height, bytes: asset.data.length, url: assetUrl(kind, asset) };
    }
  }
  return views;
}

export function toBrandingView(branding: Branding, configurable: boolean): BrandingView {
  return {
    settings: { ...branding.settings },
    effective: {
      productName: branding.productName,
      loginHeading: branding.loginHeading,
      emailSenderName: branding.emailSenderName,
      accent: branding.accent,
      poweredByShown: branding.poweredByShown,
    },
    assets: assetViews(branding),
    source: branding.source,
    updatedAt: branding.updatedAt,
    defaultProductName: BRAND_NAME,
    limits: { maxBytes: MAX_ASSET_BYTES, assets: ASSET_LIMITS },
    configurable,
  };
}

export async function getBrandingView(): Promise<BrandingView> {
  return toBrandingView(getBranding(), await isFeatureConfigurable(WHITE_LABEL_FEATURE));
}

/** After every change: replicas get the new branding (sync is best effort, like settings). */
async function propagate(): Promise<void> {
  try {
    await syncInstances();
  } catch (error) {
    console.warn("[white-label] Instance sync after a branding change failed:", error instanceof Error ? error.name : "unknown");
  }
}

/**
 * Applies a partial update. Fields restored to their defaults never need a
 * license; any other change does (403 otherwise).
 */
export async function updateBranding(input: BrandingInput, actorUserId: number): Promise<BrandingView> {
  // Read, check and write in one transaction: a concurrent change is never lost.
  const updated = await appDb.transaction(async () => {
    const current = await loadBranding();
    const next: BrandingSettings = { ...current.settings, ...input };
    if (next.accentColorDark && !next.accentColor) {
      throw new ApiValidationError("Set accentColor (the light theme's colour) before accentColorDark");
    }
    const changed = (Object.keys(next) as (keyof BrandingSettings)[]).filter((field) => next[field] !== current.settings[field]);
    if (changed.length === 0) return false;
    if (fieldsNeedingLicense(current.settings, next).length > 0) await requireFeature(WHITE_LABEL_FEATURE);

    await writeBranding(next, current.assets);
    await logAuditEvent({
      userId: actorUserId,
      action: "branding_updated",
      entityType: "branding",
      summary: `Updated branding: ${changed.join(", ")}`,
      data: {
        changed,
        previous: Object.fromEntries(changed.map((field) => [field, current.settings[field]])),
        next: Object.fromEntries(changed.map((field) => [field, next[field]])),
      },
    });
    return true;
  }, { behavior: "immediate" });
  if (updated) await propagate();
  return getBrandingView();
}

export type BrandingUpload = {
  data: Uint8Array;
  fileName?: string | null;
  declaredType?: string | null;
};

/** Stores a logo or favicon after the checks in images.ts. Needs a license. */
export async function uploadBrandingAsset(kind: AssetKind, upload: BrandingUpload, actorUserId: number): Promise<BrandingView> {
  await requireFeature(WHITE_LABEL_FEATURE);
  const image = sanitizeImage(upload.data, { ...ASSET_LIMITS[kind], maxBytes: MAX_ASSET_BYTES });
  checkDeclaredFile(image.type, upload.fileName ?? null, upload.declaredType ?? null);
  const asset = loadedAsset(image);

  await appDb.transaction(async () => {
    const current = await loadBranding();
    await writeBranding(current.settings, { ...current.assets, [kind]: asset });
    await logAuditEvent({
      userId: actorUserId,
      action: "branding_asset_uploaded",
      entityType: "branding",
      summary: `Uploaded ${ASSET_LABELS[kind].toLowerCase()} (${image.width}×${image.height}, ${image.data.length} bytes)`,
      data: { asset: kind, type: image.type, width: image.width, height: image.height, bytes: image.data.length, version: asset.version },
    });
  }, { behavior: "immediate" });
  await propagate();
  return getBrandingView();
}

/** Removes a logo or favicon; never needs a license. Removing one that is not set changes nothing. */
export async function deleteBrandingAsset(kind: AssetKind, actorUserId: number): Promise<BrandingView> {
  const removed = await appDb.transaction(async () => {
    const current = await loadBranding();
    if (!current.assets[kind]) return false;
    await writeBranding(current.settings, { ...current.assets, [kind]: null });
    await logAuditEvent({
      userId: actorUserId,
      action: "branding_asset_deleted",
      entityType: "branding",
      summary: `Removed ${ASSET_LABELS[kind].toLowerCase()}`,
      data: { asset: kind },
    });
    return true;
  }, { behavior: "immediate" });
  if (!removed) return getBrandingView();
  await propagate();
  return getBrandingView();
}

/**
 * Restores the default branding on this instance; never needs a license. On
 * a sync slave the master's branding applies again.
 */
export async function resetBranding(actorUserId: number): Promise<BrandingView> {
  await appDb.transaction(async () => {
    const current = await loadBranding();
    await clearBranding();
    await logAuditEvent({
      userId: actorUserId,
      action: "branding_reset",
      entityType: "branding",
      summary: "Reset the branding to the defaults",
      data: { previousProductName: current.settings.productName },
    });
  }, { behavior: "immediate" });
  await propagate();
  return getBrandingView();
}
