/**
 * Stand-in for next/font/google under Vitest: the real module is only a
 * placeholder that Next.js's compiler replaces at build time.
 */
type FontOptions = { variable?: string };

function font(options: FontOptions = {}) {
  return { className: "font", variable: options.variable?.replace(/^--/, "") ?? "font", style: { fontFamily: "sans-serif" } };
}

export const IBM_Plex_Sans = font;
export const IBM_Plex_Mono = font;
