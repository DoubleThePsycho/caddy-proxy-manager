// SPDX-License-Identifier: Elastic-2.0
/**
 * White-label: the stored branding and the cached view every page, e-mail
 * and message reads through getBranding().
 *
 * The branding is one settings row ("white_label") holding the text fields,
 * the colours and the logo/favicon bytes (base64, already sanitised). On a
 * sync slave the master's copy arrives as "synced:white_label" and applies
 * unless this instance has its own, like every other synced setting.
 *
 * getBranding() is synchronous and never throws: it reads the branding from
 * memory (src/lib/db/cached-value.ts), loaded at start-up, so sign-in pages
 * and e-mails never wait for or fail because of the database. Before the
 * first load, and when the database cannot be read, it is the default
 * branding.
 *
 * The code that changes the rows reads them again at once: writeBranding,
 * clearBranding, applying a sync payload and changing the instance mode
 * (refreshBranding). A change made any other way (a standby's replicated
 * copy) shows within 30 seconds; a refresh compares the rows' updated_at
 * first and only parses them again when they changed.
 */
import { createHash } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { appDb, nowIso } from "@/src/lib/db";
import { defineCachedValue } from "@/src/lib/db/cached-value";
import { settings as settingsTable } from "@/src/lib/db/schema";
import { BRAND_NAME, BRAND_WEBSITE } from "@/src/lib/brand";
import { accentCss, accentPalette } from "./colors";
import { sanitizeImage } from "./images";
import { isDefaultSettings, normalizeStoredSettings } from "./validation";
import {
  ASSET_KINDS,
  ASSET_LIMITS,
  ASSET_SLUGS,
  DEFAULT_BRANDING_SETTINGS,
  MAX_ASSET_BYTES,
  WHITE_LABEL_SETTING_KEY,
  type AccentPalette,
  type AssetKind,
  type BrandingSettings,
  type ImageType,
  type PublicBranding,
} from "./types";

const SYNCED_KEY = `synced:${WHITE_LABEL_SETTING_KEY}`;
const INSTANCE_MODE_KEY = "instance_mode";
const ROW_KEYS = [WHITE_LABEL_SETTING_KEY, SYNCED_KEY, INSTANCE_MODE_KEY];

export type LoadedAsset = {
  type: ImageType;
  width: number;
  height: number;
  data: Buffer;
  /** First 16 hex digits of the SHA-256 of `data`: the URL version and the ETag. */
  version: string;
};

export type Branding = {
  settings: BrandingSettings;
  assets: Record<AssetKind, LoadedAsset | null>;
  source: "default" | "local" | "master";
  updatedAt: string | null;
  productName: string;
  loginHeading: string;
  emailSenderName: string | null;
  accent: AccentPalette | null;
  /** The "Powered by" note shows: a name or logo of your own is set and the note is not turned off. */
  poweredByShown: boolean;
};

/** What is stored for one asset. */
type StoredAsset = { type: ImageType; width: number; height: number; data: string };

function emptyAssets(): Record<AssetKind, LoadedAsset | null> {
  return { logoLight: null, logoDark: null, favicon: null };
}

function resolve(
  settings: BrandingSettings,
  assets: Record<AssetKind, LoadedAsset | null>,
  source: Branding["source"],
  updatedAt: string | null
): Branding {
  const productName = settings.productName ?? BRAND_NAME;
  const hasLogo = assets.logoLight !== null || assets.logoDark !== null;
  return {
    settings,
    assets,
    source,
    updatedAt,
    productName,
    loginHeading: settings.loginHeading ?? productName,
    emailSenderName: settings.emailSenderName,
    accent: settings.accentColor ? accentPalette(settings.accentColor, settings.accentColorDark) : null,
    poweredByShown: settings.showPoweredBy && (productName !== BRAND_NAME || hasLogo),
  };
}

export const DEFAULT_BRANDING: Branding = resolve(DEFAULT_BRANDING_SETTINGS, emptyAssets(), "default", null);

function versionOf(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex").slice(0, 16);
}

/** A stored asset, checked again exactly like an upload; null when it does not pass. */
function loadAsset(kind: AssetKind, value: unknown): LoadedAsset | null {
  if (value === null || typeof value !== "object") return null;
  const data = (value as { data?: unknown }).data;
  if (typeof data !== "string" || data.length > Math.ceil(MAX_ASSET_BYTES / 3) * 4 + 4) return null;
  try {
    const image = sanitizeImage(Buffer.from(data, "base64"), { ...ASSET_LIMITS[kind], maxBytes: MAX_ASSET_BYTES });
    return { type: image.type, width: image.width, height: image.height, data: image.data, version: versionOf(image.data) };
  } catch {
    return null;
  }
}

function parseJson(raw: string | undefined): unknown {
  if (raw === undefined) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function instanceMode(stored: unknown): "standalone" | "master" | "slave" {
  // The environment variable wins, as in instance-sync.ts.
  for (const value of [process.env.INSTANCE_MODE, stored]) {
    if (value === "standalone" || value === "master" || value === "slave") return value;
  }
  return "standalone";
}

type Row = { key: string; value: string; updatedAt: string };

function fromRows(rows: Row[]): Branding {
  const byKey = new Map(rows.map((row) => [row.key, row]));
  const mode = instanceMode(parseJson(byKey.get(INSTANCE_MODE_KEY)?.value));
  let row = byKey.get(WHITE_LABEL_SETTING_KEY);
  let stored = parseJson(row?.value);
  let source: Branding["source"] = "local";
  // getEffectiveSetting(): on a slave this instance's own value wins, the master's applies otherwise.
  if ((stored === null || typeof stored !== "object") && mode === "slave") {
    row = byKey.get(SYNCED_KEY);
    stored = parseJson(row?.value);
    source = "master";
  }
  if (stored === null || typeof stored !== "object" || Array.isArray(stored)) return DEFAULT_BRANDING;

  const settings = normalizeStoredSettings(stored);
  const storedAssets = (stored as { assets?: unknown }).assets;
  const assets = emptyAssets();
  if (storedAssets !== null && typeof storedAssets === "object") {
    for (const kind of ASSET_KINDS) {
      assets[kind] = loadAsset(kind, (storedAssets as Record<string, unknown>)[kind]);
    }
  }
  if (isDefaultSettings(settings) && ASSET_KINDS.every((kind) => assets[kind] === null)) return DEFAULT_BRANDING;
  return resolve(settings, assets, source, row?.updatedAt ?? null);
}

type Loaded = { stamp: string; branding: Branding };

/** What a change to any of the rows changes: the instance mode from the environment and every row's updated_at. */
function stampOf(rows: Array<{ key: string; updatedAt: string }>): string {
  return [process.env.INSTANCE_MODE ?? "", ...rows.map((row) => `${row.key}@${row.updatedAt}`).sort()].join("|");
}

/** Reads the rows, unless their updated_at shows the loaded branding is still current. */
async function readBranding(current: Loaded | undefined): Promise<Loaded> {
  if (current) {
    const stamps = await appDb
      .select({ key: settingsTable.key, updatedAt: settingsTable.updatedAt })
      .from(settingsTable)
      .where(inArray(settingsTable.key, ROW_KEYS));
    if (stampOf(stamps) === current.stamp) return current;
  }
  const rows = await appDb
    .select({ key: settingsTable.key, value: settingsTable.value, updatedAt: settingsTable.updatedAt })
    .from(settingsTable)
    .where(inArray(settingsTable.key, ROW_KEYS));
  return { stamp: stampOf(rows), branding: fromRows(rows) };
}

// A background refresh that finds the rows unchanged returns the loaded value
// itself, so the parsed branding is reused until it changes.
const brandingCache = defineCachedValue<Loaded>("white-label branding", {
  load: readBranding,
  fallback: { stamp: "", branding: DEFAULT_BRANDING },
});

/**
 * Reads the branding again after its rows changed (a sync payload applied,
 * the instance mode changed) and returns it.
 */
export async function refreshBranding(): Promise<Branding> {
  return (await brandingCache.changed()).branding;
}

/** Reads the branding from the database; throws when it cannot be read (write paths use this). */
export async function loadBranding(): Promise<Branding> {
  return (await brandingCache.refresh()).branding;
}

/** The branding in effect, from memory; the default branding before it is loaded or when nothing is set. */
export function getBranding(): Branding {
  return brandingCache.current().branding;
}

/** Forgets the loaded branding (tests): the next getBranding() is the default until it is read again. */
export function resetBrandingCache(): void {
  brandingCache.reset();
}

/** The product name to show users: the white-label name, or the real one. */
export function brandName(): string {
  return getBranding().productName;
}

export function assetUrl(kind: AssetKind, asset: LoadedAsset): string {
  return `/api/branding/${ASSET_SLUGS[kind]}?v=${asset.version}`;
}

export function toPublicBranding(branding: Branding): PublicBranding {
  const { logoLight, logoDark, favicon } = branding.assets;
  const light = logoLight ? assetUrl("logoLight", logoLight) : null;
  const dark = logoDark ? assetUrl("logoDark", logoDark) : null;
  return {
    productName: branding.productName,
    loginHeading: branding.loginHeading,
    loginFooter: branding.settings.loginFooter,
    supportUrl: branding.settings.supportUrl,
    supportEmail: branding.settings.supportEmail,
    logoLightUrl: light ?? dark,
    logoDarkUrl: dark ?? light,
    faviconUrl: favicon ? assetUrl("favicon", favicon) : null,
    poweredBy: branding.poweredByShown ? { name: BRAND_NAME, url: BRAND_WEBSITE } : null,
  };
}

export function getPublicBranding(): PublicBranding {
  return toPublicBranding(getBranding());
}

/** The style sheet that applies the accent colour, or null for the default theme. */
export function brandingThemeCss(branding: Branding = getBranding()): string | null {
  return branding.accent ? accentCss(branding.accent) || null : null;
}

export function getBrandingAsset(kind: AssetKind): LoadedAsset | null {
  return getBranding().assets[kind];
}

function toStoredAsset(asset: LoadedAsset): StoredAsset {
  return { type: asset.type, width: asset.width, height: asset.height, data: asset.data.toString("base64") };
}

/**
 * Stores this instance's branding, or removes it when `settings` are the
 * defaults and no asset is set (on a slave the master's applies again).
 */
export async function writeBranding(settings: BrandingSettings, assets: Record<AssetKind, LoadedAsset | null>): Promise<void> {
  if (isDefaultSettings(settings) && ASSET_KINDS.every((kind) => assets[kind] === null)) {
    await clearBranding();
    return;
  }
  const storedAssets: Partial<Record<AssetKind, StoredAsset>> = {};
  for (const kind of ASSET_KINDS) {
    const asset = assets[kind];
    if (asset) storedAssets[kind] = toStoredAsset(asset);
  }
  const value = JSON.stringify({ ...settings, assets: storedAssets });
  const now = nowIso();
  await appDb.insert(settingsTable)
    .values({ key: WHITE_LABEL_SETTING_KEY, value, updatedAt: now })
    .onConflictDoUpdate({ target: settingsTable.key, set: { value, updatedAt: now } });
  await brandingCache.changed();
}

/** Removes this instance's branding. */
export async function clearBranding(): Promise<void> {
  await appDb.delete(settingsTable).where(eq(settingsTable.key, WHITE_LABEL_SETTING_KEY));
  await brandingCache.changed();
}

/** Builds a loaded asset from an image sanitizeImage() returned. */
export function loadedAsset(image: { type: ImageType; width: number; height: number; data: Buffer }): LoadedAsset {
  return { ...image, version: versionOf(image.data) };
}
