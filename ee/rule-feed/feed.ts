// SPDX-License-Identifier: Elastic-2.0
/**
 * The signed rule feed: its document format, the payload schema and the
 * checks a feed passes before anything in it is used.
 *
 *   {"v":1,"payload":"<base64url(payload JSON)>","signature":"<base64url(Ed25519)>"}
 *
 * The signature covers "ingressi-rule-feed:v1.<payload>", a context of its
 * own, so neither a license key nor any other Ed25519 signature can be
 * replayed as a feed (and a feed signature is no license). Like licenses
 * (ee/licensing/license.ts), payloads name their signing key (kid) and the
 * trusted public keys live in the code (public-keys.ts), so verification
 * needs no network and works on air-gapped installs.
 *
 * A feed is accepted only as a whole: the signature must match a trusted key,
 * it must not have expired or be issued in the future, its sequence must be
 * higher than the installed one (or the very same feed), it must stay within
 * the size limits, and every pack and every rule must pass the schema and the
 * SecLang allowlist (seclang.ts). Any violation rejects the whole feed and
 * nothing changes.
 *
 * Pure: callers pass the trusted keys, the time and the installed feed.
 */
import { createHash, createPublicKey, verify, type KeyObject } from "node:crypto";
import { RuleFeedError, validateRenderablePack, type ValidatedPackRules } from "./seclang";
import {
  isVirtualPatchMode,
  PACK_SEVERITIES,
  RULE_FEED_LIMITS,
  type InstalledRuleFeed,
  type PackAffected,
  type PackSample,
  type PackSeverity,
  type RuleFeedPayload,
  type RulePack,
} from "./types";

export { RuleFeedError };

export const RULE_FEED_VERSION = "v1";
const SIGNING_CONTEXT = "ingressi-rule-feed:";
const DAY_MS = 24 * 60 * 60 * 1000;

export type TrustedFeedKeys = ReadonlyMap<string, KeyObject>;

/** Builds a public key from the 32 raw bytes of an Ed25519 key, base64url-encoded. */
export function ed25519PublicKey(rawBase64Url: string): KeyObject {
  return createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: rawBase64Url }, format: "jwk" });
}

/** The bytes a feed signature covers. */
export function feedSigningInput(payloadPart: string): Buffer {
  return Buffer.from(`${SIGNING_CONTEXT}${RULE_FEED_VERSION}.${payloadPart}`, "utf8");
}

const BASE64URL = /^[A-Za-z0-9_-]+$/;
const PACK_ID = /^[a-z0-9][a-z0-9-]{2,63}$/;
const CVE_ID = /^CVE-\d{4}-\d{4,7}$/;
const KID = /^[A-Za-z0-9._-]{1,64}$/;
const SAMPLE_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;
const PRINTABLE = /^[\x20-\x7e]*$/;

const PAYLOAD_KEYS = new Set(["v", "kid", "sequence", "issuedAt", "expiresAt", "packs"]);
const PACK_KEYS = new Set([
  "id", "cves", "title", "summary", "affected", "severity", "publishedAt", "updatedAt", "references", "defaultMode", "rules", "samples", "example",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
  throw new RuleFeedError(message);
}

function onlyKeys(record: Record<string, unknown>, allowed: ReadonlySet<string>, where: string): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) fail(`${where}: unknown field "${key.slice(0, 40)}"`);
  }
}

function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function text(value: unknown, max: number, where: string, field: string, multiline = false): string {
  if (typeof value !== "string" || value.trim().length === 0) fail(`${where}: ${field} must be a non-empty string`);
  if (value.length > max) fail(`${where}: ${field} is longer than ${max} characters`);
  // Shown in the dashboard and audit log as plain text; control characters have no place there.
  if (hasControlCharacter(multiline ? value.replace(/\n/g, "") : value)) fail(`${where}: ${field} contains control characters`);
  return value;
}

function isoInstant(value: unknown, where: string, field: string): string {
  if (typeof value !== "string" || value.length > 40 || Number.isNaN(Date.parse(value))) fail(`${where}: ${field} must be an ISO 8601 time`);
  return value;
}

function list<T>(value: unknown, max: number, where: string, field: string, item: (entry: unknown, index: number) => T, min = 0): T[] {
  if (!Array.isArray(value)) fail(`${where}: ${field} must be a list`);
  if (value.length < min) fail(`${where}: ${field} needs at least ${min} ${min === 1 ? "entry" : "entries"}`);
  if (value.length > max) fail(`${where}: ${field} may have at most ${max} entries`);
  return value.map(item);
}

function httpsUrl(value: unknown, where: string): string {
  const url = text(value, RULE_FEED_LIMITS.urlLength, where, "a reference");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    fail(`${where}: reference "${url.slice(0, 80)}" is not a URL`);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) fail(`${where}: references must be https:// URLs without credentials`);
  return url;
}

function parseAffected(value: unknown, where: string): PackAffected {
  if (!isRecord(value)) fail(`${where}: each affected entry must be an object`);
  onlyKeys(value, new Set(["product", "versions", "fixed"]), where);
  return {
    product: text(value.product, RULE_FEED_LIMITS.textLength, where, "affected.product"),
    versions: text(value.versions, RULE_FEED_LIMITS.textLength, where, "affected.versions"),
    ...(value.fixed !== undefined ? { fixed: text(value.fixed, RULE_FEED_LIMITS.textLength, where, "affected.fixed") } : {}),
  };
}

function parseSample(value: unknown, where: string): PackSample {
  if (!isRecord(value)) fail(`${where}: each sample must be an object`);
  onlyKeys(value, new Set(["method", "path", "headers", "body"]), where);
  const { method, path, headers, body } = value;
  if (typeof method !== "string" || !SAMPLE_METHODS.has(method)) fail(`${where}: a sample's method must be one of ${[...SAMPLE_METHODS].join(", ")}`);
  if (typeof path !== "string" || !path.startsWith("/") || path.length > RULE_FEED_LIMITS.samplePathLength || !/^[\x21-\x7e]+$/.test(path)) {
    fail(`${where}: a sample's path must start with / and be printable ASCII without spaces`);
  }
  const sample: PackSample = { method, path };
  if (headers !== undefined) {
    if (!isRecord(headers)) fail(`${where}: a sample's headers must be an object`);
    const entries = Object.entries(headers);
    if (entries.length > RULE_FEED_LIMITS.sampleHeaders) fail(`${where}: a sample may have at most ${RULE_FEED_LIMITS.sampleHeaders} headers`);
    for (const [name, headerValue] of entries) {
      if (!HEADER_NAME.test(name)) fail(`${where}: "${name.slice(0, 40)}" is not a header name`);
      if (typeof headerValue !== "string" || headerValue.length > RULE_FEED_LIMITS.sampleHeaderValueLength || !PRINTABLE.test(headerValue)) {
        fail(`${where}: header ${name} must be printable ASCII`);
      }
    }
    sample.headers = Object.fromEntries(entries) as Record<string, string>;
  }
  if (body !== undefined) {
    if (typeof body !== "string" || body.length > RULE_FEED_LIMITS.sampleBodyLength || !PRINTABLE.test(body)) {
      fail(`${where}: a sample's body must be printable ASCII`);
    }
    sample.body = body;
  }
  return sample;
}

export type VerifiedPack = { pack: RulePack; validated: ValidatedPackRules };

/** Validates one pack field by field; unknown fields are refused. */
export function parseRulePack(raw: unknown, index: number): VerifiedPack {
  const where = `pack ${index + 1}`;
  if (!isRecord(raw)) fail(`${where}: must be an object`);
  if (typeof raw.id !== "string" || !PACK_ID.test(raw.id)) fail(`${where}: id must be 3-64 lowercase letters, digits and dashes`);
  const at = `pack ${raw.id}`;
  onlyKeys(raw, PACK_KEYS, at);
  const cves = list(raw.cves, RULE_FEED_LIMITS.cvesPerPack, at, "cves", (cve) => {
    if (typeof cve !== "string" || !CVE_ID.test(cve)) fail(`${at}: "${String(cve).slice(0, 40)}" is not a CVE id`);
    return cve;
  }, 1);
  if (new Set(cves).size !== cves.length) fail(`${at}: a CVE id is listed twice`);
  if (!(PACK_SEVERITIES as readonly unknown[]).includes(raw.severity)) fail(`${at}: severity must be one of ${PACK_SEVERITIES.join(", ")}`);
  if (!isVirtualPatchMode(raw.defaultMode)) fail(`${at}: defaultMode must be off, detect or block`);
  if (raw.example !== undefined && typeof raw.example !== "boolean") fail(`${at}: example must be true or false`);
  if (!isRecord(raw.samples)) fail(`${at}: samples must be an object with positive and negative lists`);
  onlyKeys(raw.samples, new Set(["positive", "negative"]), at);
  const pack: RulePack = {
    id: raw.id,
    cves,
    title: text(raw.title, RULE_FEED_LIMITS.titleLength, at, "title"),
    summary: text(raw.summary, RULE_FEED_LIMITS.summaryLength, at, "summary", true),
    affected: list(raw.affected, RULE_FEED_LIMITS.affectedPerPack, at, "affected", (entry) => parseAffected(entry, at), 1),
    severity: raw.severity as PackSeverity,
    publishedAt: isoInstant(raw.publishedAt, at, "publishedAt"),
    updatedAt: isoInstant(raw.updatedAt, at, "updatedAt"),
    references: list(raw.references, RULE_FEED_LIMITS.referencesPerPack, at, "references", (url) => httpsUrl(url, at)),
    defaultMode: raw.defaultMode,
    rules: [],
    samples: {
      positive: list(raw.samples.positive, RULE_FEED_LIMITS.samplesPerKind, at, "samples.positive", (sample) => parseSample(sample, at), 1),
      negative: list(raw.samples.negative, RULE_FEED_LIMITS.samplesPerKind, at, "samples.negative", (sample) => parseSample(sample, at)),
    },
    ...(raw.example ? { example: true } : {}),
  };
  if (Date.parse(pack.updatedAt) < Date.parse(pack.publishedAt)) fail(`${at}: updatedAt is before publishedAt`);
  const validated = validateRenderablePack(pack, raw.rules, at);
  pack.rules = [...(raw.rules as string[])];
  return { pack, validated };
}

/** Validates a decoded payload; unknown fields are refused. Does not look at the signature or the dates. */
export function parseRuleFeedPayload(raw: unknown): { payload: RuleFeedPayload; packs: VerifiedPack[] } {
  if (!isRecord(raw)) fail("The feed payload is not an object");
  onlyKeys(raw, PAYLOAD_KEYS, "The feed");
  if (raw.v !== 1) fail("This feed needs a newer version of Ingressi");
  if (typeof raw.kid !== "string" || !KID.test(raw.kid)) fail("The feed's key id is not valid");
  if (typeof raw.sequence !== "number" || !Number.isSafeInteger(raw.sequence) || raw.sequence < 1) {
    fail("The feed's sequence must be a positive integer");
  }
  const issuedAt = isoInstant(raw.issuedAt, "The feed", "issuedAt");
  const expiresAt = isoInstant(raw.expiresAt, "The feed", "expiresAt");
  if (Date.parse(expiresAt) <= Date.parse(issuedAt)) fail("The feed expires before it is issued");
  if (Date.parse(expiresAt) - Date.parse(issuedAt) > RULE_FEED_LIMITS.maxValidityDays * DAY_MS) {
    fail(`The feed claims to be valid for more than ${RULE_FEED_LIMITS.maxValidityDays} days`);
  }
  if (!Array.isArray(raw.packs)) fail("The feed's packs must be a list");
  if (raw.packs.length > RULE_FEED_LIMITS.packs) fail(`The feed has more than ${RULE_FEED_LIMITS.packs} packs`);
  const packs = raw.packs.map((pack, index) => parseRulePack(pack, index));
  const packIds = new Set<string>();
  const ruleIds = new Set<number>();
  for (const { pack, validated } of packs) {
    if (packIds.has(pack.id)) fail(`Pack id ${pack.id} appears twice in the feed`);
    packIds.add(pack.id);
    for (const id of validated.ruleIds) {
      if (ruleIds.has(id)) fail(`pack ${pack.id}: rule id ${id} is used by another pack`);
      ruleIds.add(id);
    }
  }
  return {
    payload: { v: 1, kid: raw.kid, sequence: raw.sequence, issuedAt, expiresAt, packs: packs.map(({ pack }) => pack) },
    packs,
  };
}

export type VerifiedRuleFeed = {
  payload: RuleFeedPayload;
  packs: VerifiedPack[];
  /** SHA-256 of the signed payload part, hex. */
  digest: string;
};

/**
 * Verifies a feed document: size, envelope, signature by a trusted key (over
 * the feed's own signing context), dates against `now`, then the payload and
 * every pack and rule. Throws RuleFeedError; nothing in a feed that throws is
 * used. The sequence is checked against the installed feed separately
 * (checkFeedSequence).
 */
export function verifyRuleFeed(document: string, keys: TrustedFeedKeys, now: Date): VerifiedRuleFeed {
  if (typeof document !== "string" || document.trim().length === 0) fail("The feed is empty");
  if (Buffer.byteLength(document, "utf8") > RULE_FEED_LIMITS.feedBytes) {
    fail(`The feed is larger than ${RULE_FEED_LIMITS.feedBytes / (1024 * 1024)} MiB`);
  }
  let envelope: unknown;
  try {
    envelope = JSON.parse(document);
  } catch {
    fail("The feed is not JSON");
  }
  if (!isRecord(envelope)) fail("The feed is not a feed document");
  onlyKeys(envelope, new Set(["v", "payload", "signature"]), "The feed document");
  if (envelope.v !== 1) fail("This feed needs a newer version of Ingressi");
  const { payload: payloadPart, signature: signaturePart } = envelope;
  if (typeof payloadPart !== "string" || !BASE64URL.test(payloadPart)) fail("The feed's payload is not base64url");
  if (typeof signaturePart !== "string" || !BASE64URL.test(signaturePart)) fail("The feed's signature is not base64url");

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
  } catch {
    fail("The feed's payload is not JSON");
  }
  // The signature is checked before anything else in the payload is read.
  const kid = isRecord(decoded) && typeof decoded.kid === "string" ? decoded.kid : null;
  if (!kid || !KID.test(kid)) fail("The feed does not name its signing key");
  const key = keys.get(kid);
  if (!key) fail(`The feed was signed by an unknown key (${kid})`);
  const signature = Buffer.from(signaturePart, "base64url");
  if (signature.length !== 64 || !verify(null, feedSigningInput(payloadPart), key, signature)) {
    fail("The feed's signature does not match: it was changed after signing or not signed by this key");
  }

  const { payload, packs } = parseRuleFeedPayload(decoded);
  const nowMs = now.getTime();
  if (Date.parse(payload.issuedAt) - RULE_FEED_LIMITS.clockSkewMs > nowMs) fail("The feed is issued in the future; check this server's clock");
  if (nowMs > Date.parse(payload.expiresAt)) fail(`The feed expired on ${payload.expiresAt.slice(0, 10)}; get a newer one`);
  return { payload, packs, digest: createHash("sha256").update(payloadPart).digest("hex") };
}

/**
 * Whether a verified feed may replace the installed one: "newer" for a
 * higher sequence, "same" for the installed feed itself (nothing to do).
 * A lower sequence is a rollback and is refused, as is a different feed
 * with the installed sequence.
 */
export function checkFeedSequence(
  feed: Pick<VerifiedRuleFeed, "digest"> & { payload: Pick<RuleFeedPayload, "sequence"> },
  installed: Pick<InstalledRuleFeed, "sequence" | "digest"> | null
): "newer" | "same" {
  if (!installed) return "newer";
  if (feed.payload.sequence > installed.sequence) return "newer";
  if (feed.payload.sequence === installed.sequence) {
    if (feed.digest === installed.digest) return "same";
    fail(`This feed has the installed sequence ${installed.sequence} but different content; it is refused`);
  }
  fail(`This feed (sequence ${feed.payload.sequence}) is older than the installed one (sequence ${installed.sequence}); feeds never go back`);
}

/** Signs a payload into a feed document (the publisher script and tests). */
export function feedDocument(payloadPart: string, signature: Buffer): string {
  return `${JSON.stringify({ v: 1, payload: payloadPart, signature: signature.toString("base64url") })}\n`;
}
