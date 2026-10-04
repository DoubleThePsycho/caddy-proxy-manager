// SPDX-License-Identifier: Elastic-2.0
/**
 * Accent colours: strict hex parsing, WCAG contrast and the CSS that applies
 * them. Pure functions, safe to import from client components (the branding
 * page uses them for its live preview).
 *
 * Only "#rgb" and "#rrggbb" are accepted and every colour is normalised to
 * lowercase "#rrggbb" before it reaches CSS, so a stored value can never carry
 * anything but six hex digits into a style sheet.
 */
import type { AccentPalette, AccentShade } from "./types";

const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const NORMALISED_HEX = /^#[0-9a-f]{6}$/;

/** The surfaces primary-coloured text and controls sit on (globals.css: --panel). */
export const LIGHT_SURFACE = "#ffffff";
export const DARK_SURFACE = "#15181e";

/**
 * The raised panels accent-coloured text also sits on (globals.css: --panel2),
 * the harder of the two surfaces of each theme for contrast.
 */
const LIGHT_RAISED_SURFACE = "#f4f5f8";
const DARK_RAISED_SURFACE = "#1b1f27";

/** Text on the accent: whichever of these contrasts more. Either gives at least 4.58:1. */
const LIGHT_TEXT = "#ffffff";
const DARK_TEXT = "#000000";

/** WCAG 2.2 1.4.11 / large text: the accent against the page. */
export const MIN_ACCENT_CONTRAST = 3;
/** WCAG 2.2 1.4.3 AA: text on the accent. */
export const MIN_TEXT_CONTRAST = 4.5;

/** "#rrggbb" in lowercase, or null when `value` is not a 3- or 6-digit hex colour. */
export function normalizeHexColor(value: string): string | null {
  const trimmed = value.trim();
  if (!HEX_COLOR.test(trimmed)) return null;
  const digits = trimmed.slice(1).toLowerCase();
  const full = digits.length === 3 ? digits.split("").map((d) => d + d).join("") : digits;
  return `#${full}`;
}

export function isNormalizedHexColor(value: unknown): value is string {
  return typeof value === "string" && NORMALISED_HEX.test(value);
}

function channels(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function toHex([r, g, b]: [number, number, number]): string {
  return `#${[r, g, b].map((c) => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, "0")).join("")}`;
}

/** WCAG relative luminance of a normalised colour. */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = channels(hex).map((c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** One decimal, rounded down, so "3.0:1" is never shown for a colour that fails 3:1. */
export function formatRatio(ratio: number): string {
  return `${(Math.floor(ratio * 10) / 10).toFixed(1)}:1`;
}

/** The text colour for labels on the accent (buttons, badges). */
export function foregroundFor(hex: string): string {
  return contrastRatio(hex, LIGHT_TEXT) >= contrastRatio(hex, DARK_TEXT) ? LIGHT_TEXT : DARK_TEXT;
}

function shade(color: string): AccentShade {
  return { color, foreground: foregroundFor(color) };
}

/**
 * Why `hex` cannot be the accent of the given theme, or null when it can: it
 * needs 3:1 against that theme's surface, or links and outlines in the accent
 * colour would be unreadable.
 */
export function accentContrastProblem(hex: string, theme: "light" | "dark"): string | null {
  const surface = theme === "light" ? LIGHT_SURFACE : DARK_SURFACE;
  const ratio = contrastRatio(hex, surface);
  if (ratio >= MIN_ACCENT_CONTRAST) return null;
  const advice = theme === "light" ? "choose a darker shade" : "choose a lighter shade or leave it empty to derive one";
  return `${hex} has a contrast of ${formatRatio(ratio)} against the ${theme} theme's background; it needs at least ${MIN_ACCENT_CONTRAST}:1, so ${advice}`;
}

/**
 * The dark-theme accent derived from the light one: the same colour when it
 * already contrasts enough with the dark surface, otherwise mixed with white
 * in small steps until it does.
 */
export function deriveDarkAccent(light: string): string {
  if (contrastRatio(light, DARK_SURFACE) >= MIN_ACCENT_CONTRAST) return light;
  const [r, g, b] = channels(light);
  for (let step = 1; step <= 20; step++) {
    const t = step / 20;
    const mixed = toHex([r + (255 - r) * t, g + (255 - g) * t, b + (255 - b) * t]);
    if (contrastRatio(mixed, DARK_SURFACE) >= MIN_ACCENT_CONTRAST) return mixed;
  }
  return "#ffffff";
}

/**
 * The accent as text (links, selected labels, outlines) for a theme: the
 * colour itself when it reaches 4.5:1 on that theme's panels, otherwise
 * mixed towards white (dark theme) or black (light theme) in small steps
 * until it does.
 */
export function readableAccent(hex: string, theme: "light" | "dark"): string {
  const surfaces = theme === "light" ? [LIGHT_SURFACE, LIGHT_RAISED_SURFACE] : [DARK_SURFACE, DARK_RAISED_SURFACE];
  const target = theme === "light" ? 0 : 255;
  const readable = (color: string) => surfaces.every((surface) => contrastRatio(color, surface) >= MIN_TEXT_CONTRAST);
  if (readable(hex)) return hex;
  const [r, g, b] = channels(hex);
  for (let step = 1; step <= 20; step++) {
    const t = step / 20;
    const mixed = toHex([r + (target - r) * t, g + (target - g) * t, b + (target - b) * t]);
    if (readable(mixed)) return mixed;
  }
  return theme === "light" ? "#000000" : "#ffffff";
}

/** The palette for a stored light accent and optional dark accent (both normalised). */
export function accentPalette(light: string, dark: string | null): AccentPalette {
  return { light: shade(light), dark: shade(dark ?? deriveDarkAccent(light)) };
}

/**
 * The style sheet that applies a palette through the accent tokens of
 * app/globals.css: the fill of buttons and its label colour, the accent as
 * text (made readable on the theme's panels) and its tint. Unlayered, so it
 * wins over the layered defaults; dark is the default theme and the light
 * rule comes last, so it wins on an element with the "light" class. Returns
 * "" if any value is not a normalised hex colour, which validation already
 * rules out.
 */
export function accentCss(palette: AccentPalette): string {
  const values = [palette.light.color, palette.light.foreground, palette.dark.color, palette.dark.foreground];
  if (!values.every((value) => NORMALISED_HEX.test(value))) return "";
  const rule = (selector: string, { color, foreground }: AccentShade, theme: "light" | "dark") => {
    const text = readableAccent(color, theme);
    const tint = theme === "light" ? 9 : 14;
    return `${selector}{--brand-fill:${color};--on-brand-fill:${foreground};--brand:${text};--brand-tint:color-mix(in srgb,${text} ${tint}%,transparent)}`;
  };
  return `${rule(":root,.dark", palette.dark, "dark")}${rule(".light", palette.light, "light")}`;
}
