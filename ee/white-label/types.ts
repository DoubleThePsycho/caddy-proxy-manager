// SPDX-License-Identifier: Elastic-2.0
/**
 * White-label: shared types and constants. Safe to import from client
 * components: nothing here touches the database.
 */
import { BRAND_NAME } from "@/src/lib/brand";

/** The settings key holding the branding (instance sync stores the master's as synced:white_label). */
export const WHITE_LABEL_SETTING_KEY = "white_label";

export const ASSET_KINDS = ["logoLight", "logoDark", "favicon"] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

/** URL segments of the asset routes, one per kind. */
export const ASSET_SLUGS: Record<AssetKind, string> = {
  logoLight: "logo-light",
  logoDark: "logo-dark",
  favicon: "favicon",
};

export function assetKindFromSlug(slug: string): AssetKind | null {
  return ASSET_KINDS.find((kind) => ASSET_SLUGS[kind] === slug) ?? null;
}

export const ASSET_LABELS: Record<AssetKind, string> = {
  logoLight: "Logo (light theme)",
  logoDark: "Logo (dark theme)",
  favicon: "Favicon",
};

export type ImageType = "image/png" | "image/jpeg" | "image/webp" | "image/x-icon";

export const IMAGE_TYPE_LABELS: Record<ImageType, string> = {
  "image/png": "PNG",
  "image/jpeg": "JPEG",
  "image/webp": "WebP",
  "image/x-icon": "ICO",
};

/** Upper bound on an uploaded file, before and after metadata is removed. */
export const MAX_ASSET_BYTES = 512 * 1024;

export type AssetLimits = { types: readonly ImageType[]; maxWidth: number; maxHeight: number };

export const ASSET_LIMITS: Record<AssetKind, AssetLimits> = {
  logoLight: { types: ["image/png", "image/jpeg", "image/webp"], maxWidth: 2048, maxHeight: 2048 },
  logoDark: { types: ["image/png", "image/jpeg", "image/webp"], maxWidth: 2048, maxHeight: 2048 },
  favicon: { types: ["image/png", "image/x-icon", "image/webp", "image/jpeg"], maxWidth: 512, maxHeight: 512 },
};

export const TEXT_LIMITS = {
  productName: 60,
  loginHeading: 100,
  loginFooter: 500,
  supportUrl: 2048,
  supportEmail: 254,
  emailSenderName: 80,
} as const;

/** The editable fields. null means "use the default". */
export type BrandingSettings = {
  productName: string | null;
  /** #rrggbb, the primary colour in the light theme. */
  accentColor: string | null;
  /** #rrggbb, the primary colour in the dark theme; derived from accentColor when null. */
  accentColorDark: string | null;
  /** Heading of the sign-in pages; the product name when null. */
  loginHeading: string | null;
  loginFooter: string | null;
  supportUrl: string | null;
  supportEmail: string | null;
  /** Display name of the From header of e-mails the product sends; the bare address when null. */
  emailSenderName: string | null;
  showPoweredBy: boolean;
};

export type BrandingInput = Partial<BrandingSettings>;

export const DEFAULT_BRANDING_SETTINGS: BrandingSettings = Object.freeze({
  productName: null,
  accentColor: null,
  accentColorDark: null,
  loginHeading: null,
  loginFooter: null,
  supportUrl: null,
  supportEmail: null,
  emailSenderName: null,
  showPoweredBy: true,
}) as BrandingSettings;

export type AccentShade = { color: string; foreground: string };
export type AccentPalette = { light: AccentShade; dark: AccentShade };

export type AssetView = {
  type: ImageType;
  width: number;
  height: number;
  bytes: number;
  /** Public URL with a version parameter, so a new upload shows at once. */
  url: string;
};

/**
 * Branding for pages and client components: what anyone may see, including
 * visitors of the sign-in pages before they sign in.
 */
export type PublicBranding = {
  productName: string;
  loginHeading: string;
  loginFooter: string | null;
  supportUrl: string | null;
  supportEmail: string | null;
  logoLightUrl: string | null;
  logoDarkUrl: string | null;
  faviconUrl: string | null;
  /** The "Powered by" note, or null when the default branding is in use or the note is turned off. */
  poweredBy: { name: string; url: string } | null;
};

/** What the dashboard and the API show administrators. */
export type BrandingView = {
  settings: BrandingSettings;
  effective: {
    productName: string;
    loginHeading: string;
    emailSenderName: string | null;
    accent: AccentPalette | null;
    poweredByShown: boolean;
  };
  assets: Record<AssetKind, AssetView | null>;
  /** Where the branding comes from: none set, this instance, or the master it syncs from. */
  source: "default" | "local" | "master";
  updatedAt: string | null;
  defaultProductName: string;
  limits: { maxBytes: number; assets: Record<AssetKind, AssetLimits> };
};

export const DEFAULT_PUBLIC_BRANDING: PublicBranding = Object.freeze({
  productName: BRAND_NAME,
  loginHeading: BRAND_NAME,
  loginFooter: null,
  supportUrl: null,
  supportEmail: null,
  logoLightUrl: null,
  logoDarkUrl: null,
  faviconUrl: null,
  poweredBy: null,
}) as PublicBranding;
