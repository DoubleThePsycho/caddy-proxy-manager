import { IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";

/**
 * IBM Plex Sans and Mono, downloaded at build time and served by the app
 * itself (no request to Google at runtime, so the CSP stays unchanged).
 * globals.css reads the two CSS variables for font-sans and font-mono.
 */
export const plexSans = IBM_Plex_Sans({
  subsets: ["latin", "latin-ext"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
  variable: "--font-plex-sans",
});

export const plexMono = IBM_Plex_Mono({
  subsets: ["latin", "latin-ext"],
  weight: ["400", "500", "600"],
  display: "swap",
  variable: "--font-plex-mono",
});

export const fontVariables = `${plexSans.variable} ${plexMono.variable}`;
