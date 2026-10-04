// SPDX-License-Identifier: Elastic-2.0
/**
 * Branding pieces shared by the sign-in pages, the forward-auth portal, the
 * API consumer portal and the dashboard. No hooks: they render from the
 * branding they are given, on the server or the client. Every text is
 * rendered as text, never as HTML.
 */
import { LifeBuoy, Mail } from "lucide-react";
import { cn } from "@/lib/utils";
import type { PublicBranding } from "../types";

type LogoProps = { branding: PublicBranding; className?: string };

/**
 * The logo for the current theme, or nothing when no logo is set. The
 * brand-logo-* classes (app/globals.css) follow the theme class next-themes
 * sets, not the operating system's preference.
 */
export function BrandLogo({ branding, className }: LogoProps) {
  const { logoLightUrl, logoDarkUrl, productName } = branding;
  if (!logoLightUrl || !logoDarkUrl) return null;
  if (logoLightUrl === logoDarkUrl) {
    return <img src={logoLightUrl} alt={productName} className={cn("object-contain", className)} />;
  }
  return (
    <>
      <img src={logoLightUrl} alt={productName} className={cn("brand-logo-light object-contain", className)} />
      <img src={logoDarkUrl} alt={productName} className={cn("brand-logo-dark object-contain", className)} />
    </>
  );
}

export function hasLogo(branding: PublicBranding): boolean {
  return Boolean(branding.logoLightUrl);
}

/** Support links: the URL and/or the e-mail address, when set. */
export function SupportLinks({ branding, className }: { branding: PublicBranding; className?: string }) {
  const { supportUrl, supportEmail } = branding;
  if (!supportUrl && !supportEmail) return null;
  return (
    <div className={cn("flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-xs text-muted-foreground", className)}>
      {supportUrl && (
        <a href={supportUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 underline-offset-4 hover:underline">
          <LifeBuoy className="h-3 w-3" /> Help and support
        </a>
      )}
      {supportEmail && (
        <a href={`mailto:${supportEmail}`} className="inline-flex items-center gap-1 underline-offset-4 hover:underline">
          <Mail className="h-3 w-3" /> {supportEmail}
        </a>
      )}
    </div>
  );
}

/** The small "Powered by" note, when it is shown. */
export function PoweredBy({ branding, className }: { branding: PublicBranding; className?: string }) {
  if (!branding.poweredBy) return null;
  return (
    <p className={cn("text-center text-[11px] text-muted-foreground/80", className)}>
      Powered by{" "}
      <a href={branding.poweredBy.url} target="_blank" rel="noopener noreferrer" className="underline-offset-4 hover:underline">
        {branding.poweredBy.name}
      </a>
    </p>
  );
}

/** Footer of the pages people sign in on: the footer text, support links and the "Powered by" note. */
export function BrandFooter({ branding, className }: { branding: PublicBranding; className?: string }) {
  const { loginFooter, supportUrl, supportEmail, poweredBy } = branding;
  if (!loginFooter && !supportUrl && !supportEmail && !poweredBy) return null;
  return (
    <div className={cn("flex flex-col items-center gap-2", className)} data-testid="brand-footer">
      {loginFooter && <p className="whitespace-pre-line text-center text-xs text-muted-foreground">{loginFooter}</p>}
      <SupportLinks branding={branding} />
      <PoweredBy branding={branding} />
    </div>
  );
}
