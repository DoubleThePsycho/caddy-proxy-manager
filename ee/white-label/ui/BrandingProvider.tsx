// SPDX-License-Identifier: Elastic-2.0
"use client";

import { createContext, useContext, type ReactNode } from "react";
import { DEFAULT_PUBLIC_BRANDING, type PublicBranding } from "../types";

const BrandingContext = createContext<PublicBranding>(DEFAULT_PUBLIC_BRANDING);

/** Gives client components the branding the root layout read on the server. */
export function BrandingProvider({ value, children }: { value: PublicBranding; children: ReactNode }) {
  return <BrandingContext.Provider value={value}>{children}</BrandingContext.Provider>;
}

/** The branding in effect: product name, logos, sign-in texts and support contact. */
export function useBranding(): PublicBranding {
  return useContext(BrandingContext);
}
