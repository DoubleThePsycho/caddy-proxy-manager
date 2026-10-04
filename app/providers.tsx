"use client";

import { ReactNode } from "react";
import { ThemeProvider, useTheme } from "next-themes";
import { Toaster } from "sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { BrandingProvider } from "@/ee/white-label/ui/BrandingProvider";
import { DEFAULT_PUBLIC_BRANDING, type PublicBranding } from "@/ee/white-label/types";

export default function Providers({
  children,
  nonce,
  branding = DEFAULT_PUBLIC_BRANDING,
}: {
  children: ReactNode;
  nonce?: string;
  branding?: PublicBranding;
}) {
  return (
    <ThemeProvider attribute="class" defaultTheme="dark" enableSystem disableTransitionOnChange nonce={nonce}>
      <BrandingProvider value={branding}>
        <TooltipProvider>
          {children}
        </TooltipProvider>
      </BrandingProvider>
      <ThemedToaster />
    </ThemeProvider>
  );
}

/** Toasts follow the theme the dashboard shows (dark unless the user picked another). */
function ThemedToaster() {
  const { resolvedTheme } = useTheme();
  return <Toaster richColors position="bottom-right" theme={resolvedTheme === "light" ? "light" : "dark"} />;
}
