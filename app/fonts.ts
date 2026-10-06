import { Inter, JetBrains_Mono } from "next/font/google";

/**
 * Inter and JetBrains Mono, downloaded at build time and served by the app
 * itself (no request to Google at runtime, so the CSP stays unchanged).
 * globals.css reads the two CSS variables for font-sans and font-mono.
 */
export const interSans = Inter({
  subsets: ["latin", "latin-ext"],
  display: "swap",
  variable: "--font-inter",
});

export const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin", "latin-ext"],
  display: "swap",
  variable: "--font-jetbrains-mono",
});

export const fontVariables = `${interSans.variable} ${jetbrainsMono.variable}`;
