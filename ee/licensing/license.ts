// SPDX-License-Identifier: Elastic-2.0
/**
 * License keys: a JSON payload signed with Ed25519.
 *
 *   v1.<base64url(payload JSON)>.<base64url(signature)>
 *
 * The signature covers "ingressi-license:v1.<payload part>", so a signature
 * made for anything else cannot be replayed as a license. Verifying a key
 * needs no network access.
 *
 * The payload's `v` says how the key is checked:
 * - 1: an offline key. Checked on this server only; air-gapped installs and
 *   trials use these.
 * - 2: an online key (purchases and trials from ingres.si). Same fields; this install must also
 *   hold a current confirmation from the license server, a status statement
 *   (below) asked for once a day. Releases before 2.0.1 refuse v2 keys
 *   ("needs a newer version"), so an older release cannot skip the check.
 *
 * Status statements, from POST /v1/licenses/{id}/status on the license
 * server:
 *
 *   s1.<base64url(payload JSON)>.<base64url(signature)>
 *
 * signed over "ingressi-license-status:s1.<payload part>" (its own context:
 * a statement can never pass as a key, nor a key as a statement) by a
 * trusted key. The payload is {v: 1, kid, id, status: "active" | "revoked" |
 * "in_use", install, iat, exp}. `install` is the SHA-256 (hex) of the asking
 * install's license install id: a statement only counts on the install it
 * was issued to. A license is active on one install at a time; "in_use"
 * says another install holds it.
 *
 * This module is pure: callers pass the trusted keys, the stored statements
 * and the current time.
 */
import { createHash, createPublicKey, verify, type KeyObject } from "node:crypto";
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
export const STATEMENT_VERSION = "s1";
const STATEMENT_CONTEXT = "ingressi-license-status:";
/** A statement may cover at most this long (the server issues 14 days). */
export const STATEMENT_MAX_VALIDITY_DAYS = 31;
/** An online key works this long after this install first saw it, before any confirmation. */
export const FIRST_CHECK_ALLOWANCE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_TOKEN_LENGTH = 8192;
const MAX_TEXT_LENGTH = 200;

export type LicensePayload = {
  /** 1: offline key; 2: online key, confirmed daily with the license server. */
  v: 1 | 2;
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

/**
 * revoked: the license server says the license was revoked. unconfirmed: an
 * online key without a current confirmation from the license server.
 * in_use: the license is active on another install. All three leave paid
 * settings read-only at once.
 */
export type LicenseStatus = "unlicensed" | "active" | "grace" | "expired" | "invalid" | "revoked" | "unconfirmed" | "in_use";

/**
 * Where an online key stands with the license server. confirmed: a current
 * confirmation; pending: none yet, within the first days after this install
 * first saw the license; unconfirmed: neither; revoked: the server says so;
 * in_use: the server says another install holds the license.
 */
export type OnlineCheckStatus = "confirmed" | "pending" | "unconfirmed" | "revoked" | "in_use";

export type OnlineCheckState = {
  state: OnlineCheckStatus;
  /** When the license server last confirmed the license (the statement's iat). */
  confirmedAt: string | null;
  /** Until when paid settings stay editable without a newer confirmation (statement exp, or end of the first days). */
  validUntil: string | null;
};

export type LicenseState = {
  status: LicenseStatus;
  license: LicensePayload | null;
  /** Features the license grants; empty unless a valid license is installed. */
  features: Feature[];
  /** End of the grace period after expiry, ISO 8601. */
  graceEndsAt: string | null;
  /** Why an installed key is not valid; safe to show to administrators. */
  error: string | null;
  /** Online keys only (v2); null for offline keys and without a key. */
  onlineCheck: OnlineCheckState | null;
};

/**
 * What this install has stored about online keys, by license id: the
 * latest status statement from the license server, and when the license
 * was first seen here; and the SHA-256 (hex) of this install's license
 * install id, which a statement must name to count. Without it no
 * statement counts.
 */
export type LicenseCheckInput = {
  statements?: Readonly<Record<string, string>>;
  firstSeen?: Readonly<Record<string, string>>;
  installHash?: string | null;
};

export type LicenseStatementStatus = "active" | "revoked" | "in_use";

export type LicenseStatement = {
  v: 1;
  kid: string;
  /** License id. */
  id: string;
  status: LicenseStatementStatus;
  /** SHA-256 (lowercase hex) of the license install id of the install the statement was issued to. */
  install: string;
  iat: string;
  exp: string;
};

/** Raised for keys that fail to parse or verify; the message is safe to show. */
export class LicenseKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LicenseKeyError";
  }
}

/** Raised for status statements that fail to parse or verify. */
export class LicenseStatementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LicenseStatementError";
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

export function statementSigningInput(payloadPart: string): Buffer {
  return Buffer.from(`${STATEMENT_CONTEXT}${STATEMENT_VERSION}.${payloadPart}`, "utf8");
}

const BASE64URL = /^[A-Za-z0-9_-]+$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

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
  if (v !== 1 && v !== 2) throw new LicenseKeyError("This license key needs a newer version of Ingressi");
  if (!isShortText(kid, 64) || !isShortText(id, 64) || !isShortText(customer)) {
    throw new LicenseKeyError("The license key is not valid");
  }
  if (email !== undefined && !isShortText(email)) throw new LicenseKeyError("The license key is not valid");
  if (!isEdition(edition)) throw new LicenseKeyError("The license key is not valid");
  if (typeof nodes !== "number" || !Number.isInteger(nodes) || nodes < 1 || nodes > 100_000) {
    throw new LicenseKeyError("The license key is not valid");
  }
  // A feature this release does not know (newer, or withdrawn) is ignored:
  // it can never grant anything here, and the rest of the key still holds.
  if (features !== undefined && (!Array.isArray(features) || !features.every((feature) => isShortText(feature, 64)))) {
    throw new LicenseKeyError("The license key is not valid");
  }
  if (trial !== undefined && typeof trial !== "boolean") throw new LicenseKeyError("The license key is not valid");
  if (!isIsoInstant(iat) || !isIsoInstant(exp) || Date.parse(exp) <= Date.parse(iat)) {
    throw new LicenseKeyError("The license key is not valid");
  }
  return {
    v,
    kid,
    id,
    customer,
    ...(email !== undefined ? { email } : {}),
    edition,
    nodes,
    ...(features !== undefined ? { features: [...new Set((features as string[]).filter(isFeature))] } : {}),
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

/** The key must be confirmed with the license server (an online key). */
export function requiresOnlineCheck(payload: LicensePayload): boolean {
  return payload.v === 2;
}

export function graceEnd(payload: LicensePayload): Date {
  return new Date(Date.parse(payload.exp) + GRACE_PERIOD_DAYS * DAY_MS);
}

/** The SHA-256 (lowercase hex) of a license install id: what a status statement names in `install`. */
export function installIdHash(installId: string): string {
  return createHash("sha256").update(installId, "utf8").digest("hex");
}

/** Validates a statement payload field by field; unknown fields are rejected. */
export function parseLicenseStatementPayload(raw: unknown): LicenseStatement {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new LicenseStatementError("The status statement is not valid");
  }
  const allowed = new Set(["v", "kid", "id", "status", "install", "iat", "exp"]);
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw new LicenseStatementError("The status statement is not valid");
  }
  const { v, kid, id, status, install, iat, exp } = record;
  if (v !== 1) throw new LicenseStatementError("The status statement needs a newer version of Ingressi");
  if (!isShortText(kid, 64) || !isShortText(id, 64)) throw new LicenseStatementError("The status statement is not valid");
  if (status !== "active" && status !== "revoked" && status !== "in_use") throw new LicenseStatementError("The status statement is not valid");
  if (typeof install !== "string" || !SHA256_HEX.test(install)) throw new LicenseStatementError("The status statement is not valid");
  if (!isIsoInstant(iat) || !isIsoInstant(exp)) throw new LicenseStatementError("The status statement is not valid");
  const from = Date.parse(iat);
  const to = Date.parse(exp);
  if (to <= from || to - from > STATEMENT_MAX_VALIDITY_DAYS * DAY_MS) {
    throw new LicenseStatementError("The status statement is not valid");
  }
  return { v: 1, kid, id, status, install, iat, exp };
}

/**
 * Parses a status statement and checks its signature and issue time (at
 * most a day ahead of `now`, for clock skew). Does not look at the license
 * id, the install or the expiry: validStatementFor and evaluateLicense do.
 */
export function verifyLicenseStatement(token: string, keys: TrustedKeys, now: Date): LicenseStatement {
  const trimmed = typeof token === "string" ? token.trim() : "";
  if (trimmed.length === 0 || trimmed.length > MAX_TOKEN_LENGTH) {
    throw new LicenseStatementError("The status statement is not valid");
  }
  const parts = trimmed.split(".");
  if (parts.length !== 3 || parts[0] !== STATEMENT_VERSION) {
    throw new LicenseStatementError("The status statement is not valid");
  }
  const [, payloadPart, signaturePart] = parts;
  if (!BASE64URL.test(payloadPart) || !BASE64URL.test(signaturePart)) {
    throw new LicenseStatementError("The status statement is not valid");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
  } catch {
    throw new LicenseStatementError("The status statement is not valid");
  }
  const statement = parseLicenseStatementPayload(decoded);
  const key = keys.get(statement.kid);
  if (!key) throw new LicenseStatementError("The status statement was signed by an unknown key");
  const signature = Buffer.from(signaturePart, "base64url");
  if (signature.length !== 64 || !verify(null, statementSigningInput(payloadPart), key, signature)) {
    throw new LicenseStatementError("The status statement's signature does not match");
  }
  if (Date.parse(statement.iat) > now.getTime() + DAY_MS) {
    throw new LicenseStatementError("The status statement is dated in the future");
  }
  return statement;
}

/**
 * The statement for `licenseId` issued to this install (`installHash`, see
 * installIdHash) when it verifies; null for anything else, and always null
 * without an install hash (never throws).
 */
export function validStatementFor(
  token: string | null | undefined,
  licenseId: string,
  keys: TrustedKeys,
  now: Date,
  installHash: string | null | undefined
): LicenseStatement | null {
  if (!token || !installHash) return null;
  try {
    const statement = verifyLicenseStatement(token, keys, now);
    return statement.id === licenseId && statement.install === installHash ? statement : null;
  } catch {
    return null;
  }
}

/**
 * Where an online key stands at `now`: the latest statement issued to this
 * install decides (revoked and in_use hold whatever their expiry, until a
 * newer statement); an active one counts until its expiry; without one, the
 * key works for FIRST_CHECK_ALLOWANCE_DAYS after this install first saw the
 * license (a key never seen counts as seen now).
 */
export function evaluateOnlineCheck(
  payload: LicensePayload,
  keys: TrustedKeys,
  now: Date,
  check: LicenseCheckInput = {}
): OnlineCheckState {
  const statement = validStatementFor(check.statements?.[payload.id], payload.id, keys, now, check.installHash);
  if (statement?.status === "revoked") {
    return { state: "revoked", confirmedAt: null, validUntil: null };
  }
  if (statement?.status === "in_use") {
    return { state: "in_use", confirmedAt: null, validUntil: null };
  }
  const nowMs = now.getTime();
  if (statement && nowMs <= Date.parse(statement.exp)) {
    return { state: "confirmed", confirmedAt: statement.iat, validUntil: statement.exp };
  }
  const seenRaw = check.firstSeen?.[payload.id];
  const seen = typeof seenRaw === "string" && !Number.isNaN(Date.parse(seenRaw)) ? Math.min(Date.parse(seenRaw), nowMs) : nowMs;
  const allowanceEnd = seen + FIRST_CHECK_ALLOWANCE_DAYS * DAY_MS;
  const confirmedAt = statement?.iat ?? null;
  if (!statement && nowMs < allowanceEnd) {
    return { state: "pending", confirmedAt: null, validUntil: new Date(allowanceEnd).toISOString() };
  }
  return { state: "unconfirmed", confirmedAt, validUntil: statement?.exp ?? new Date(allowanceEnd).toISOString() };
}

const UNLICENSED: LicenseState = { status: "unlicensed", license: null, features: [], graceEndsAt: null, error: null, onlineCheck: null };

/**
 * The state of an installed key at `now`. An expired license keeps its
 * features during the grace period; after it, they stay visible but can no
 * longer be changed (see `canConfigure`). An online key (v2) also needs a
 * current confirmation from the license server (`check`): without one, or
 * when it says the license was revoked or is active on another install,
 * paid settings are read-only at once.
 */
export function evaluateLicense(token: string | null, keys: TrustedKeys, now: Date, check?: LicenseCheckInput): LicenseState {
  if (!token) return UNLICENSED;
  let payload: LicensePayload;
  try {
    payload = verifyLicenseKey(token, keys);
  } catch (error) {
    const message = error instanceof LicenseKeyError ? error.message : "The license key is not valid";
    return { status: "invalid", license: null, features: [], graceEndsAt: null, error: message, onlineCheck: null };
  }
  const grace = graceEnd(payload);
  const nowMs = now.getTime();
  const dated: LicenseStatus =
    nowMs < Date.parse(payload.iat) - DAY_MS
      ? "invalid"
      : nowMs <= Date.parse(payload.exp)
        ? "active"
        : nowMs <= grace.getTime()
          ? "grace"
          : "expired";
  if (dated === "invalid") {
    return { status: dated, license: null, features: [], graceEndsAt: null, error: "The license key is not valid yet", onlineCheck: null };
  }
  const onlineCheck = requiresOnlineCheck(payload) ? evaluateOnlineCheck(payload, keys, now, check) : null;
  const status: LicenseStatus =
    dated === "expired" || !onlineCheck
      ? dated
      : onlineCheck.state === "revoked"
        ? "revoked"
        : onlineCheck.state === "in_use"
          ? "in_use"
          : onlineCheck.state === "unconfirmed"
            ? "unconfirmed"
            : dated;
  return { status, license: payload, features: licenseFeatures(payload), graceEndsAt: grace.toISOString(), error: null, onlineCheck };
}

/** A key that verifies is installed, whatever its dates or confirmation (not "unlicensed" or "invalid"). */
export function hasVerifiedKey(state: Pick<LicenseState, "status">): boolean {
  return state.status !== "unlicensed" && state.status !== "invalid";
}

/** Whether an administrator may set up or change a paid feature. */
export function canConfigure(state: LicenseState, feature: Feature): boolean {
  return (state.status === "active" || state.status === "grace") && state.features.includes(feature);
}
