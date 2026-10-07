// SPDX-License-Identifier: Elastic-2.0
/**
 * Charge ids: what the gate hands Caddy for each request it lets through on
 * a plan that credits failed answers, and Caddy writes into the request's
 * access log line (log_append, field "ingressi_charge"). The log pipeline
 * reads them back with the answer's status (answer-credits.ts).
 *
 * An id carries what was charged, so crediting needs no lookup:
 *
 *   c1.<consumerId>.<chargedMicros>.<free 0|1>.<issued, unix seconds>.<12 hex random>.<mac>
 *
 * mac is the first 16 bytes of HMAC-SHA256 over everything before it, keyed
 * with a key derived from the per-install gate token, base64url. Only the gate
 * can issue a valid id; the random part makes each id unique, which is what
 * the credit is made idempotent on. No database access.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const VERSION = "c1";
const KEY_INFO = "ingressi:monetization:charge-id:v1";
const MAC_BYTES = 16;
const ID_PATTERN = /^c1\.([1-9]\d{0,9})\.(\d{1,14})\.([01])\.(\d{9,11})\.([a-f0-9]{12})\.([A-Za-z0-9_-]{22})$/;

export type ChargeIdFields = { consumerId: number; chargedMicros: number; free: boolean; issuedAtMs: number };

/** The HMAC key of charge ids, from the gate token. */
export function chargeIdKey(gateToken: string): Buffer {
  return createHmac("sha256", gateToken).update(KEY_INFO).digest();
}

function mac(key: Buffer, body: string): Buffer {
  return createHmac("sha256", key).update(body).digest().subarray(0, MAC_BYTES);
}

export function issueChargeId(key: Buffer, fields: ChargeIdFields): string {
  const body = [
    VERSION,
    fields.consumerId,
    Math.max(0, Math.trunc(fields.chargedMicros)),
    fields.free ? 1 : 0,
    Math.floor(fields.issuedAtMs / 1000),
    randomBytes(6).toString("hex"),
  ].join(".");
  return `${body}.${mac(key, body).toString("base64url")}`;
}

/** The fields of a charge id this install issued, or null for anything else (malformed, forged, another install's). */
export function readChargeId(key: Buffer, id: unknown): ChargeIdFields | null {
  if (typeof id !== "string" || id.length > 120) return null;
  const match = ID_PATTERN.exec(id);
  if (!match) return null;
  const body = id.slice(0, id.lastIndexOf("."));
  const presented = Buffer.from(match[6], "base64url");
  const expected = mac(key, body);
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return null;
  const chargedMicros = Number(match[2]);
  if (!Number.isSafeInteger(chargedMicros)) return null;
  return { consumerId: Number(match[1]), chargedMicros, free: match[3] === "1", issuedAtMs: Number(match[4]) * 1000 };
}
