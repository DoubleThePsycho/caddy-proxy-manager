// SPDX-License-Identifier: Elastic-2.0
/**
 * Offline license keys: a JSON payload signed with Ed25519.
 *
 *   v1.<base64url(payload JSON)>.<base64url(signature)>
 *
 * The signature covers "ingressi-license:v1.<payload part>", so a signature
 * made for anything else cannot be replayed as a license. Verification needs
 * no network access, which keeps air-gapped installs working.
 *
 * This module is pure: callers pass the trusted keys and the current time.
 */
import { createPublicKey, verify, type KeyObject } from "node:crypto";
import {
  EDITION_FEATURES,
  isEdition,
  isFeature,
  type Edition,
  type Feature,
} from "./features";

export const LICENSE_VERSION = "v1";
const SIGNING_CONTEXT = "ingressi-license:";
export const GRACE_PERIOD_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_TOKEN_LENGTH = 8192;
const MAX_TEXT_LENGTH = 200;

export type LicensePayload = {
  v: 1;
  /** Id of the signing key, so keys can be rotated. */
  kid: string;
  /** License id, quoted in invoices and support. */
  id: string;
  customer: string;
  email?: string;
  edition: Edition;
  /** Licensed nodes (the dashboard's own node plus its sync slaves). */
  nodes: number;
  /** Features granted on top of the edition. */
  features?: Feature[];
  trial?: boolean;
  /** Issue and expiry instants, ISO 8601. */
  iat: string;
  exp: string;
};

export type LicenseStatus = "unlicensed" | "active" | "grace" | "expired" | "invalid";

export type LicenseState = {
  status: LicenseStatus;
  license: LicensePayload | null;
  /** Features the license grants; empty unless a valid license is installed. */
  features: Feature[];
  /** End of the grace period after expiry, ISO 8601. */
  graceEndsAt: string | null;
  /** Why an installed key is not valid; safe to show to administrators. */
  error: string | null;
};

/** Raised for keys that fail to parse or verify; the message is safe to show. */
export class LicenseKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LicenseKeyError";
  }
}

export type TrustedKeys = ReadonlyMap<string, KeyObject>;

/** Builds a public key from the 32 raw bytes of an Ed25519 key, base64url-encoded. */
export function ed25519PublicKey(rawBase64Url: string): KeyObject {
  return createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: rawBase64Url }, format: "jwk" });
}

export function signingInput(payloadPart: string): Buffer {
  return Buffer.from(`${SIGNING_CONTEXT}${LICENSE_VERSION}.${payloadPart}`, "utf8");
}

const BASE64URL = /^[A-Za-z0-9_-]+$/;

function isIsoInstant(value: unknown): value is string {
  return typeof value === "string" && value.length <= 40 && !Number.isNaN(Date.parse(value));
}

function isShortText(value: unknown, max = MAX_TEXT_LENGTH): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}

/** Validates the decoded payload field by field; unknown fields are rejected. */
export function parseLicensePayload(raw: unknown): LicensePayload {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new LicenseKeyError("The license key is not valid");
  }
  const allowed = new Set(["v", "kid", "id", "customer", "email", "edition", "nodes", "features", "trial", "iat", "exp"]);
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw new LicenseKeyError("The license key is not valid");
  }
  const { v, kid, id, customer, email, edition, nodes, features, trial, iat, exp } = record;
  if (v !== 1) throw new LicenseKeyError("This license key needs a newer version of Ingressi");
  if (!isShortText(kid, 64) || !isShortText(id, 64) || !isShortText(customer)) {
    throw new LicenseKeyError("The license key is not valid");
  }
  if (email !== undefined && !isShortText(email)) throw new LicenseKeyError("The license key is not valid");
  if (!isEdition(edition)) throw new LicenseKeyError("The license key is not valid");
  if (typeof nodes !== "number" || !Number.isInteger(nodes) || nodes < 1 || nodes > 100_000) {
    throw new LicenseKeyError("The license key is not valid");
  }
  if (features !== undefined && (!Array.isArray(features) || !features.every(isFeature))) {
    throw new LicenseKeyError("The license key is not valid");
  }
  if (trial !== undefined && typeof trial !== "boolean") throw new LicenseKeyError("The license key is not valid");
  if (!isIsoInstant(iat) || !isIsoInstant(exp) || Date.parse(exp) <= Date.parse(iat)) {
    throw new LicenseKeyError("The license key is not valid");
  }
  return {
    v: 1,
    kid,
    id,
    customer,
    ...(email !== undefined ? { email } : {}),
    edition,
    nodes,
    ...(features !== undefined ? { features: [...new Set(features as Feature[])] } : {}),
    ...(trial !== undefined ? { trial } : {}),
    iat,
    exp,
  };
}

/** Parses a key and checks its signature. Does not look at the dates. */
export function verifyLicenseKey(token: string, keys: TrustedKeys): LicensePayload {
  const trimmed = token.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_TOKEN_LENGTH) {
    throw new LicenseKeyError("The license key is not valid");
  }
  const parts = trimmed.split(".");
  if (parts.length !== 3 || parts[0] !== LICENSE_VERSION) {
    throw new LicenseKeyError("The license key is not valid");
  }
  const [, payloadPart, signaturePart] = parts;
  if (!BASE64URL.test(payloadPart) || !BASE64URL.test(signaturePart)) {
    throw new LicenseKeyError("The license key is not valid");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
  } catch {
    throw new LicenseKeyError("The license key is not valid");
  }
  const payload = parseLicensePayload(decoded);
  const key = keys.get(payload.kid);
  if (!key) throw new LicenseKeyError("The license key was signed by an unknown key");
  const signature = Buffer.from(signaturePart, "base64url");
  if (signature.length !== 64 || !verify(null, signingInput(payloadPart), key, signature)) {
    throw new LicenseKeyError("The license key's signature does not match");
  }
  return payload;
}

export function licenseFeatures(payload: LicensePayload): Feature[] {
  return [...new Set([...EDITION_FEATURES[payload.edition], ...(payload.features ?? [])])];
}

export function graceEnd(payload: LicensePayload): Date {
  return new Date(Date.parse(payload.exp) + GRACE_PERIOD_DAYS * DAY_MS);
}

const UNLICENSED: LicenseState = { status: "unlicensed", license: null, features: [], graceEndsAt: null, error: null };

/**
 * The state of an installed key at `now`. An expired license keeps its
 * features during the grace period; after it, they stay visible but can no
 * longer be changed (see `canConfigure`).
 */
export function evaluateLicense(token: string | null, keys: TrustedKeys, now: Date): LicenseState {
  if (!token) return UNLICENSED;
  let payload: LicensePayload;
  try {
    payload = verifyLicenseKey(token, keys);
  } catch (error) {
    const message = error instanceof LicenseKeyError ? error.message : "The license key is not valid";
    return { status: "invalid", license: null, features: [], graceEndsAt: null, error: message };
  }
  const grace = graceEnd(payload);
  const nowMs = now.getTime();
  const status: LicenseStatus =
    nowMs < Date.parse(payload.iat) - DAY_MS
      ? "invalid"
      : nowMs <= Date.parse(payload.exp)
        ? "active"
        : nowMs <= grace.getTime()
          ? "grace"
          : "expired";
  if (status === "invalid") {
    return { status, license: null, features: [], graceEndsAt: null, error: "The license key is not valid yet" };
  }
  return { status, license: payload, features: licenseFeatures(payload), graceEndsAt: grace.toISOString(), error: null };
}

/** Whether an administrator may set up or change a paid feature. */
export function canConfigure(state: LicenseState, feature: Feature): boolean {
  return (state.status === "active" || state.status === "grace") && state.features.includes(feature);
}
