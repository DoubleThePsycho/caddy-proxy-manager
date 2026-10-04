// SPDX-License-Identifier: Elastic-2.0
/**
 * AWS Signature Version 4, header-based, with node:crypto only.
 * https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-create-signed-request.html
 *
 * The path follows S3's rules: each segment is URI-encoded once and the path
 * is not normalized (other AWS services encode it twice; for "/" there is no
 * difference). Nothing here logs or keeps the credentials.
 */
import { createHash, createHmac } from "node:crypto";

export const SIGV4_ALGORITHM = "AWS4-HMAC-SHA256";
/** SHA-256 of an empty payload. */
export const EMPTY_PAYLOAD_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export type SigV4Credentials = { accessKeyId: string; secretAccessKey: string };

export type SigV4Input = {
  method: string;
  url: URL;
  /** Headers to send, all of them signed. Host is taken from the URL unless given. */
  headers: Record<string, string>;
  /** Hex SHA-256 of the payload, or "UNSIGNED-PAYLOAD". */
  payloadHash: string;
  region: string;
  service: string;
  credentials: SigV4Credentials;
  date: Date;
};

export type SigV4Result = {
  /** The input headers plus x-amz-date and authorization, with lower-case names. */
  headers: Record<string, string>;
  canonicalRequest: string;
  stringToSign: string;
  signature: string;
  signedHeaders: string;
};

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

const UNRESERVED = /^[A-Za-z0-9\-._~]$/;

/**
 * S3's UriEncode: RFC 3986 unreserved characters stay, every other UTF-8
 * byte becomes %XX with upper-case hex. "/" stays when encodeSlash is false.
 */
export function uriEncode(value: string, encodeSlash = true): string {
  let out = "";
  for (const char of value) {
    if (UNRESERVED.test(char) || (char === "/" && !encodeSlash)) {
      out += char;
      continue;
    }
    for (const byte of Buffer.from(char, "utf8")) {
      out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }
  return out;
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** 20130524T000000Z */
export function amzDate(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/[-:]/g, "");
}

export function canonicalUri(url: URL): string {
  const path = url.pathname || "/";
  return path
    .split("/")
    .map((segment) => uriEncode(decode(segment)))
    .join("/");
}

export function canonicalQueryString(url: URL): string {
  const raw = url.search.startsWith("?") ? url.search.slice(1) : url.search;
  if (!raw) return "";
  const pairs = raw
    .split("&")
    .filter((part) => part.length > 0)
    .map((part): [string, string] => {
      const index = part.indexOf("=");
      const key = index < 0 ? part : part.slice(0, index);
      const value = index < 0 ? "" : part.slice(index + 1);
      return [uriEncode(decode(key)), uriEncode(decode(value))];
    });
  pairs.sort(([ak, av], [bk, bv]) => (ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0));
  return pairs.map(([key, value]) => `${key}=${value}`).join("&");
}

function canonicalHeaderValue(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

export function signingKey(secretAccessKey: string, dateStamp: string, region: string, service: string): Buffer {
  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, "aws4_request");
}

/** Signs a request; returns the headers to send (Authorization included). */
export function signV4(input: SigV4Input): SigV4Result {
  const stamp = amzDate(input.date);
  const dateStamp = stamp.slice(0, 8);

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.headers)) headers[name.toLowerCase()] = value;
  delete headers.authorization;
  headers["x-amz-date"] = stamp;

  const signing: Record<string, string> = { ...headers };
  if (signing.host === undefined) signing.host = input.url.host;
  const names = Object.keys(signing).sort();
  const canonicalHeaders = names.map((name) => `${name}:${canonicalHeaderValue(signing[name])}\n`).join("");
  const signedHeaders = names.join(";");

  const canonicalRequest = [
    input.method.toUpperCase(),
    canonicalUri(input.url),
    canonicalQueryString(input.url),
    canonicalHeaders,
    signedHeaders,
    input.payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = [SIGV4_ALGORITHM, stamp, scope, sha256Hex(canonicalRequest)].join("\n");
  const signature = createHmac("sha256", signingKey(input.credentials.secretAccessKey, dateStamp, input.region, input.service))
    .update(stringToSign, "utf8")
    .digest("hex");

  headers.authorization =
    `${SIGV4_ALGORITHM} Credential=${input.credentials.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { headers, canonicalRequest, stringToSign, signature, signedHeaders };
}
