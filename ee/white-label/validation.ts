// SPDX-License-Identifier: Elastic-2.0
/**
 * White-label input validation. Every text field is plain text: control and
 * invisible formatting characters (bidi overrides, zero-width characters)
 * are refused so a name cannot be made to look like another one, and
 * nothing is ever interpreted as HTML. Colours are strict hex.
 */
import { ApiValidationError } from "@/src/lib/api-errors";
import { accentContrastProblem, normalizeHexColor } from "./colors";
import { DEFAULT_BRANDING_SETTINGS, TEXT_LIMITS, type BrandingInput, type BrandingSettings } from "./types";

const FIELDS = [
  "productName",
  "accentColor",
  "accentColorDark",
  "loginHeading",
  "loginFooter",
  "supportUrl",
  "supportEmail",
  "emailSenderName",
  "showPoweredBy",
] as const satisfies readonly (keyof BrandingSettings)[];

/** Control characters and Unicode format characters (Cf: bidi overrides, zero-width characters). */
const FORBIDDEN_CHARACTERS = /[\p{Cc}\p{Cf}\u2028\u2029]/u;

/** Strict on purpose: the address becomes a mailto: link, where "?", "&" or "%" would change its meaning. */
const EMAIL_ADDRESS = /^[A-Za-z0-9._+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;

function readText(value: unknown, field: keyof typeof TEXT_LIMITS, multiline = false): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new ApiValidationError(`${field} must be a string or null`);
  const text = multiline ? value.replace(/\r\n?/g, "\n").trim() : value.trim();
  if (text.length === 0) return null;
  if (text.length > TEXT_LIMITS[field]) throw new ApiValidationError(`${field} must be at most ${TEXT_LIMITS[field]} characters`);
  // A multi-line field may hold line feeds (carriage returns were folded into them above).
  if (FORBIDDEN_CHARACTERS.test(multiline ? text.replace(/\n/g, "") : text)) {
    throw new ApiValidationError(`${field} must not contain control or invisible formatting characters`);
  }
  return text;
}

function readColor(value: unknown, field: string, theme: "light" | "dark"): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new ApiValidationError(`${field} must be a hex colour such as #1d4ed8, or null`);
  if (value.trim() === "") return null;
  const color = normalizeHexColor(value);
  if (!color) throw new ApiValidationError(`${field} must be a hex colour such as #1d4ed8`);
  const problem = accentContrastProblem(color, theme);
  if (problem) throw new ApiValidationError(`${field}: ${problem}`);
  return color;
}

function readSupportUrl(value: unknown): string | null {
  const text = readText(value, "supportUrl");
  if (text === null) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new ApiValidationError("supportUrl must be a valid URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new ApiValidationError("supportUrl must start with https:// or http://");
  if (url.username || url.password) throw new ApiValidationError("supportUrl must not contain a user name or password");
  return url.toString();
}

function readSupportEmail(value: unknown): string | null {
  const text = readText(value, "supportEmail");
  if (text === null) return null;
  if (!EMAIL_ADDRESS.test(text)) throw new ApiValidationError("supportEmail must be an e-mail address");
  return text;
}

/**
 * Validates a PUT body or form submission: a partial update, where a field
 * left out keeps its value and null or "" restores its default. Unknown
 * fields are refused. Throws ApiValidationError (400).
 */
export function parseBrandingInput(body: unknown): BrandingInput {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new ApiValidationError("Body must be a JSON object");
  }
  const record = body as Record<string, unknown>;
  const unknown = Object.keys(record).filter((key) => !(FIELDS as readonly string[]).includes(key));
  if (unknown.length > 0) throw new ApiValidationError(`Unknown field: ${unknown[0].slice(0, 60)}`);

  const input: BrandingInput = {};
  const has = (key: string) => Object.prototype.hasOwnProperty.call(record, key);
  if (has("productName")) input.productName = readText(record.productName, "productName");
  if (has("accentColor")) input.accentColor = readColor(record.accentColor, "accentColor", "light");
  if (has("accentColorDark")) input.accentColorDark = readColor(record.accentColorDark, "accentColorDark", "dark");
  if (has("loginHeading")) input.loginHeading = readText(record.loginHeading, "loginHeading");
  if (has("loginFooter")) input.loginFooter = readText(record.loginFooter, "loginFooter", true);
  if (has("supportUrl")) input.supportUrl = readSupportUrl(record.supportUrl);
  if (has("supportEmail")) input.supportEmail = readSupportEmail(record.supportEmail);
  if (has("emailSenderName")) input.emailSenderName = readText(record.emailSenderName, "emailSenderName");
  if (has("showPoweredBy")) {
    if (typeof record.showPoweredBy !== "boolean") throw new ApiValidationError("showPoweredBy must be true or false");
    input.showPoweredBy = record.showPoweredBy;
  }
  return input;
}

/** Drops whatever does not validate, field by field, instead of throwing. */
function lenient<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

/**
 * A stored value (this instance's or one synced from a master) as settings.
 * It is validated again on every read: a field that does not pass, from a
 * hand-edited database or another release, falls back to its default.
 */
export function normalizeStoredSettings(value: unknown): BrandingSettings {
  const record = value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const d = DEFAULT_BRANDING_SETTINGS;
  return {
    productName: lenient(() => readText(record.productName, "productName"), d.productName),
    accentColor: lenient(() => readColor(record.accentColor, "accentColor", "light"), d.accentColor),
    accentColorDark: lenient(() => readColor(record.accentColorDark, "accentColorDark", "dark"), d.accentColorDark),
    loginHeading: lenient(() => readText(record.loginHeading, "loginHeading"), d.loginHeading),
    loginFooter: lenient(() => readText(record.loginFooter, "loginFooter", true), d.loginFooter),
    supportUrl: lenient(() => readSupportUrl(record.supportUrl), d.supportUrl),
    supportEmail: lenient(() => readSupportEmail(record.supportEmail), d.supportEmail),
    emailSenderName: lenient(() => readText(record.emailSenderName, "emailSenderName"), d.emailSenderName),
    showPoweredBy: typeof record.showPoweredBy === "boolean" ? record.showPoweredBy : d.showPoweredBy,
  };
}

export function isDefaultSettings(settings: BrandingSettings): boolean {
  return FIELDS.every((field) => settings[field] === DEFAULT_BRANDING_SETTINGS[field]);
}
