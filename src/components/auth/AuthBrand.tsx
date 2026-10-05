"use client";

import { BRAND_NAME } from "@/src/lib/brand";
import { useBranding } from "@/ee/white-label/ui/BrandingProvider";
import { BrandLogo, hasLogo } from "@/ee/white-label/ui/BrandParts";

/** The product mark next to the product name when no logo is set. */
function ProductMark() {
  return (
    <svg width="36" height="36" viewBox="0 0 28 28" aria-hidden="true" className="flex-none">
      <rect width="28" height="28" rx="7" className="fill-primary" />
      <path
        d="M11 8v3M11 17v3M22 8v12M6 14h12M15 11l3 3-3 3"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="text-primary-foreground"
      />
    </svg>
  );
}

/**
 * The logo, or the product name (with the mark for the default brand),
 * above the card of the pages outside the dashboard: sign-in steps and the
 * error pages.
 */
export function AuthBrand() {
  const branding = useBranding();
  return (
    <div className="flex items-center justify-center gap-3">
      {hasLogo(branding) ? (
        <BrandLogo branding={branding} className="max-h-12 w-auto max-w-[220px]" />
      ) : (
        <>
          {branding.productName === BRAND_NAME && <ProductMark />}
          <span className="text-[22px] font-bold leading-7 tracking-tight">{branding.productName}</span>
        </>
      )}
    </div>
  );
}
