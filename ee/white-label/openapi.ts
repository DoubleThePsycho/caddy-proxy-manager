// SPDX-License-Identifier: Elastic-2.0
/**
 * OpenAPI paths and schemas of the white-label endpoints, spread into
 * app/api/v1/openapi.json/route.ts.
 */
import { MAX_ASSET_BYTES, TEXT_LIMITS } from "./types";

const TAG = "White-label";

export const WHITE_LABEL_OPENAPI_TAG = {
  name: TAG,
  description:
    "Your own product name, logos, favicon, accent colour, sign-in texts, support contact and e-mail sender name (Enterprise edition). " +
    "Setting a value of your own and uploading an image need the white_label feature; restoring a default, removing an image, " +
    "resetting and reading never do, and configured branding keeps showing when the license lapses. The license page, license " +
    "texts, legal notices, HTTP header names and other identifiers keep the real product name.",
};

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: unknown) => ({ "application/json": { schema } });
const errors = (...codes: string[]) => {
  const map: Record<string, unknown> = {
    "400": { $ref: "#/components/responses/BadRequest" },
    "401": { $ref: "#/components/responses/Unauthorized" },
    "403": { $ref: "#/components/responses/Forbidden" },
    "404": { $ref: "#/components/responses/NotFound" },
    "413": { description: `The upload is larger than ${MAX_ASSET_BYTES / 1024} KB`, content: json(ref("Error")) },
  };
  return Object.fromEntries(codes.map((code) => [code, map[code]]));
};

const assetParam = {
  name: "asset",
  in: "path",
  required: true,
  schema: { type: "string", enum: ["logo-light", "logo-dark", "favicon"] },
};

const imageTypes = ["image/png", "image/jpeg", "image/webp", "image/x-icon"];
const binary = { type: "string", format: "binary" };

export const WHITE_LABEL_OPENAPI_PATHS = {
  "/api/v1/branding": {
    get: {
      tags: [TAG],
      summary: "Get the branding",
      description: "Permission branding:read. Available without a license.",
      operationId: "getBranding",
      responses: { "200": { description: "Branding", content: json(ref("Branding")) }, ...errors("401", "403") },
    },
    put: {
      tags: [TAG],
      summary: "Update the branding",
      description:
        "Permission branding:write (administrator-level). A partial update: fields left out keep their values, null or an empty " +
        "string restores the default. Setting a value of your own needs the white_label feature (403 otherwise); restoring defaults " +
        "does not. Colours are #rgb or #rrggbb and need 3:1 contrast with the theme's background; the text colour on them is chosen " +
        "for at least 4.5:1. Text may not contain control or invisible formatting characters.",
      operationId: "updateBranding",
      requestBody: { required: true, content: json(ref("BrandingInput")) },
      responses: { "200": { description: "Updated", content: json(ref("Branding")) }, ...errors("400", "401", "403") },
    },
    delete: {
      tags: [TAG],
      summary: "Reset the branding",
      description:
        "Permission branding:write. Restores every default and removes the logos and favicon. Never needs a license. On a sync " +
        "slave the master's branding applies again.",
      operationId: "resetBranding",
      responses: { "200": { description: "Reset", content: json(ref("Branding")) }, ...errors("401", "403") },
    },
  },
  "/api/v1/branding/assets/{asset}": {
    put: {
      tags: [TAG],
      summary: "Upload a logo or the favicon",
      description:
        `Permission branding:write; needs the white_label feature. Logos: PNG, JPEG or WebP up to 2048×2048; favicon: PNG, ICO, ` +
        `WebP or JPEG up to 512×512; at most ${MAX_ASSET_BYTES / 1024} KB. Send multipart/form-data with a "file" field, or the ` +
        "image as the body. The type comes from the content; SVG, files with data after the image, and files containing HTML or " +
        "script are refused. Text and EXIF/XMP metadata are removed before the image is stored.",
      operationId: "uploadBrandingAsset",
      parameters: [assetParam],
      requestBody: {
        required: true,
        content: {
          "multipart/form-data": {
            schema: { type: "object", properties: { file: binary }, required: ["file"] },
          },
          ...Object.fromEntries(imageTypes.map((type) => [type, { schema: binary }])),
        },
      },
      responses: { "200": { description: "Stored", content: json(ref("Branding")) }, ...errors("400", "401", "403", "404", "413") },
    },
    delete: {
      tags: [TAG],
      summary: "Remove a logo or the favicon",
      description: "Permission branding:write. Never needs a license. Removing one that is not set changes nothing.",
      operationId: "deleteBrandingAsset",
      parameters: [assetParam],
      responses: { "200": { description: "Removed", content: json(ref("Branding")) }, ...errors("401", "403", "404") },
    },
  },
  "/api/branding/{asset}": {
    get: {
      tags: [TAG],
      summary: "Serve a logo or the favicon",
      description:
        "Public (the sign-in pages show it before sign-in). With the current version in ?v= the answer may be cached for a year; " +
        "otherwise it is revalidated with its ETag. Sent with X-Content-Type-Options: nosniff and a sandboxing Content-Security-Policy.",
      operationId: "getBrandingAssetImage",
      security: [],
      parameters: [assetParam, { name: "v", in: "query", required: false, schema: { type: "string" } }],
      responses: {
        "200": { description: "The image", content: Object.fromEntries(imageTypes.map((type) => [type, { schema: binary }])) },
        "304": { description: "Not modified" },
        "404": { description: "No such image is set" },
      },
    },
  },
};

const nullableText = (maxLength: number, description?: string) => ({
  type: ["string", "null"],
  maxLength,
  ...(description ? { description } : {}),
});
const color = (description: string) => ({ type: ["string", "null"], pattern: "^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$", description });

const settingsProperties = {
  productName: nullableText(TEXT_LIMITS.productName, "Shown instead of the real product name; null for the default"),
  accentColor: color("Primary colour in the light theme"),
  accentColorDark: color("Primary colour in the dark theme; derived from accentColor when null"),
  loginHeading: nullableText(TEXT_LIMITS.loginHeading, "Heading of the sign-in pages; the product name when null"),
  loginFooter: nullableText(TEXT_LIMITS.loginFooter, "Text under the sign-in forms; line breaks are kept"),
  supportUrl: { type: ["string", "null"], format: "uri", maxLength: TEXT_LIMITS.supportUrl, description: "http(s) URL" },
  supportEmail: { type: ["string", "null"], format: "email", maxLength: TEXT_LIMITS.supportEmail },
  emailSenderName: nullableText(TEXT_LIMITS.emailSenderName, "Display name of the From header of alert and digest e-mails; the bare address when null"),
  showPoweredBy: { type: "boolean", description: 'Show a small "Powered by" note when a name or logo of your own is set (default true)' },
};

const accentShade = {
  type: "object",
  properties: { color: { type: "string" }, foreground: { type: "string" } },
  required: ["color", "foreground"],
};

const assetLimits = {
  type: "object",
  properties: {
    types: { type: "array", items: { type: "string", enum: imageTypes } },
    maxWidth: { type: "integer" },
    maxHeight: { type: "integer" },
  },
  required: ["types", "maxWidth", "maxHeight"],
};

const nullableAsset = { oneOf: [ref("BrandingAsset"), { type: "null" }] };

export const WHITE_LABEL_OPENAPI_SCHEMAS = {
  BrandingSettings: {
    type: "object",
    properties: settingsProperties,
    required: Object.keys(settingsProperties),
  },
  BrandingInput: {
    type: "object",
    additionalProperties: false,
    properties: settingsProperties,
  },
  BrandingAsset: {
    type: "object",
    properties: {
      type: { type: "string", enum: imageTypes },
      width: { type: "integer" },
      height: { type: "integer" },
      bytes: { type: "integer" },
      url: { type: "string", description: "Public URL with a version parameter" },
    },
    required: ["type", "width", "height", "bytes", "url"],
  },
  Branding: {
    type: "object",
    properties: {
      settings: ref("BrandingSettings"),
      effective: {
        type: "object",
        properties: {
          productName: { type: "string" },
          loginHeading: { type: "string" },
          emailSenderName: { type: ["string", "null"] },
          accent: {
            oneOf: [
              { type: "object", properties: { light: accentShade, dark: accentShade }, required: ["light", "dark"] },
              { type: "null" },
            ],
          },
          poweredByShown: { type: "boolean" },
        },
        required: ["productName", "loginHeading", "emailSenderName", "accent", "poweredByShown"],
      },
      assets: {
        type: "object",
        properties: { logoLight: nullableAsset, logoDark: nullableAsset, favicon: nullableAsset },
        required: ["logoLight", "logoDark", "favicon"],
      },
      source: { type: "string", enum: ["default", "local", "master"], description: "master: synced from the instance this one is a slave of" },
      updatedAt: { type: ["string", "null"], format: "date-time" },
      defaultProductName: { type: "string" },
      limits: {
        type: "object",
        properties: {
          maxBytes: { type: "integer" },
          assets: {
            type: "object",
            properties: { logoLight: assetLimits, logoDark: assetLimits, favicon: assetLimits },
            required: ["logoLight", "logoDark", "favicon"],
          },
        },
        required: ["maxBytes", "assets"],
      },
      configurable: { type: "boolean", description: "The license lets administrators set up or change the branding now" },
    },
    required: ["settings", "effective", "assets", "source", "updatedAt", "defaultProductName", "limits", "configurable"],
  },
};
