import type { ReactNode } from "react";
import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";
import { fontVariables } from "./fonts";
import Providers from "./providers";
import { BRAND_TAGLINE } from "@/src/lib/brand";
import { brandingThemeCss, getBranding, toPublicBranding } from "@/ee/white-label/store";

/** Titles, description and favicon follow the white-label branding (ee/white-label). */
export async function generateMetadata(): Promise<Metadata> {
  const branding = getBranding();
  const { faviconUrl } = toPublicBranding(branding);
  const favicon = branding.assets.favicon;
  return {
    title: { default: branding.productName, template: `%s · ${branding.productName}` },
    description: BRAND_TAGLINE,
    ...(favicon && faviconUrl ? { icons: { icon: [{ url: faviconUrl, type: favicon.type }] } } : {}),
  };
}

function getNonce(csp: string | null): string | undefined {
  if (!csp) return undefined;
  const m = csp.match(/'nonce-([A-Za-z0-9+/=]+)'/);
  return m?.[1];
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const h = await headers();
  const nonce = getNonce(h.get("Content-Security-Policy"));
  const branding = getBranding();
  // Only six-digit hex colours reach this style sheet (ee/white-label/colors.ts).
  const themeCss = brandingThemeCss(branding);

  return (
    <html lang="en" className={fontVariables} suppressHydrationWarning>
      <head>{themeCss && <style id="brand-theme" dangerouslySetInnerHTML={{ __html: themeCss }} />}</head>
      <body>
        <Providers nonce={nonce} branding={toPublicBranding(branding)}>{children}</Providers>
      </body>
    </html>
  );
}
