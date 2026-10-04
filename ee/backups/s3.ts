// SPDX-License-Identifier: Elastic-2.0
/**
 * A minimal S3 client (PUT, GET, ListObjectsV2, DELETE) for AWS S3 and
 * S3-compatible storage, signed with SigV4 (sigv4.ts).
 *
 * - Redirects are never followed and every request has a timeout.
 * - Errors are S3Error instances whose messages are safe to store and show:
 *   they name the HTTP status and S3's error code, never a response body, a
 *   URL, a header or a credential. Nothing here logs.
 */
import { EMPTY_PAYLOAD_SHA256, sha256Hex, signV4, uriEncode, type SigV4Credentials } from "./sigv4";

export const S3_REQUEST_TIMEOUT_MS = 30_000;
/** Uploads and downloads of a backup file (up to 50 MiB). */
export const S3_TRANSFER_TIMEOUT_MS = 5 * 60_000;
const MAX_ERROR_BODY_BYTES = 64 * 1024;
const MAX_LIST_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_LIST_PAGES = 100;
const LIST_PAGE_SIZE = 1000;
const ERROR_CODE = /^[A-Za-z][A-Za-z0-9.]{0,63}$/;
const NETWORK_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;
const REGION = /^[a-z0-9][a-z0-9-]{0,62}$/;

export type S3Location = {
  /** Origin of the S3 API, e.g. https://s3.eu-central-1.amazonaws.com */
  endpoint: string;
  region: string;
  bucket: string;
  /** https://endpoint/bucket/key instead of https://bucket.endpoint/key */
  pathStyle: boolean;
};

/** The part of fetch the client uses; tests pass a fake. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export type S3ClientOptions = {
  fetch?: FetchLike;
  now?: () => Date;
  timeoutMs?: number;
  transferTimeoutMs?: number;
};

export type S3Object = { key: string; size: number; lastModified: string | null };

export class S3Error extends Error {
  readonly status: number | null;
  readonly code: string | null;
  constructor(message: string, options: { status?: number | null; code?: string | null } = {}) {
    super(message);
    this.name = "S3Error";
    this.status = options.status ?? null;
    this.code = options.code ?? null;
  }
}

const CODE_HINTS: Record<string, string> = {
  AccessDenied: "access denied; check that the key may read, write, list and delete objects in the bucket",
  AllAccessDisabled: "access to the bucket is disabled",
  InvalidAccessKeyId: "the access key ID is not known to the storage provider",
  SignatureDoesNotMatch: "the signature does not match; check the secret access key",
  NoSuchBucket: "the bucket does not exist",
  NoSuchKey: "the object does not exist",
  PermanentRedirect: "the bucket must be addressed through another endpoint; check the endpoint, the region and path-style addressing",
  AuthorizationHeaderMalformed: "the request was signed for the wrong region; check the region",
  IllegalLocationConstraintException: "the bucket is in another region; check the region",
  RequestTimeTooSkewed: "this server's clock differs too much from the storage provider's",
  InvalidBucketName: "the bucket name is not valid for this provider",
  QuotaExceeded: "the storage quota is exceeded",
  EntityTooLarge: "the file is larger than the provider accepts",
  XAmzContentSHA256Mismatch: "the upload was corrupted in transit (checksum mismatch)",
  BadDigest: "the upload was corrupted in transit (checksum mismatch)",
};

/** A message naming a network failure without echoing anything the peer sent. */
export function describeNetworkError(error: unknown, timeoutMs: number): string {
  const candidates = [error, (error as { cause?: unknown } | null)?.cause];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const { name, code } = candidate as { name?: unknown; code?: unknown };
    if (name === "TimeoutError" || name === "AbortError") return `Timed out after ${Math.round(timeoutMs / 1000)} s`;
    if (typeof code === "string" && NETWORK_CODE.test(code)) return `Connection failed (${code})`;
  }
  return "Connection failed";
}

function decodeXml(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (match, entity: string) => {
    switch (entity) {
      case "amp":
        return "&";
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "quot":
        return '"';
      case "apos":
        return "'";
    }
    const code = entity.startsWith("#x") ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
    return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
  });
}

function xmlElement(xml: string, name: string): string | null {
  const match = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(xml);
  return match ? decodeXml(match[1]) : null;
}

export type ListObjectsPage = { objects: S3Object[]; isTruncated: boolean; nextContinuationToken: string | null };

/** Parses a ListObjectsV2 response. */
export function parseListObjectsV2(xml: string): ListObjectsPage {
  if (!/<ListBucketResult[\s>]/.test(xml)) throw new S3Error("The storage answered the listing with an unexpected response");
  const objects: S3Object[] = [];
  for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const key = xmlElement(match[1], "Key");
    if (key === null) continue;
    const size = Number(xmlElement(match[1], "Size") ?? "0");
    const lastModified = xmlElement(match[1], "LastModified");
    const date = lastModified ? new Date(lastModified) : null;
    objects.push({
      key,
      size: Number.isFinite(size) && size >= 0 ? size : 0,
      lastModified: date && !Number.isNaN(date.getTime()) ? date.toISOString() : null,
    });
  }
  const isTruncated = (xmlElement(xml, "IsTruncated") ?? "false").trim() === "true";
  const token = xmlElement(xml, "NextContinuationToken");
  return { objects, isTruncated, nextContinuationToken: token && token.length > 0 ? token : null };
}

async function readLimited(response: Response, maxBytes: number, timeoutMs: number): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new S3Error(`The object is larger than ${Math.floor(maxBytes / (1024 * 1024))} MiB`);
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new S3Error(`The object is larger than ${Math.floor(maxBytes / (1024 * 1024))} MiB`);
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    if (error instanceof S3Error) throw error;
    throw new S3Error(describeNetworkError(error, timeoutMs));
  }
  return Buffer.concat(chunks);
}

async function errorFromResponse(response: Response): Promise<S3Error> {
  let body = "";
  try {
    body = (await readLimited(response, MAX_ERROR_BODY_BYTES, S3_REQUEST_TIMEOUT_MS)).toString("utf8");
  } catch {
    // The status is what matters.
  }
  const rawCode = /<Code>([^<]{1,64})<\/Code>/.exec(body)?.[1]?.trim() ?? null;
  const code = rawCode && ERROR_CODE.test(rawCode) ? rawCode : null;
  const status = response.status;
  let message = `HTTP ${status}${code ? ` (${code})` : ""} from the storage`;
  const hint = code ? CODE_HINTS[code] : undefined;
  if (hint) message += `: ${hint}`;
  else if (status >= 300 && status < 400) {
    message += ": redirects are not followed; check the endpoint, the region and path-style addressing";
  } else if (status === 403 && !code) message += ": access denied";
  else if (status === 404 && !code) message += ": not found; check the bucket and path-style addressing";
  const bucketRegion = response.headers.get("x-amz-bucket-region")?.trim();
  if (bucketRegion && REGION.test(bucketRegion)) message += ` (the bucket is in region ${bucketRegion})`;
  return new S3Error(message, { status, code });
}

function isIpLiteral(hostname: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) || hostname.startsWith("[");
}

export class S3Client {
  private readonly fetchImpl: FetchLike;
  private readonly now: () => Date;
  private readonly timeoutMs: number;
  private readonly transferTimeoutMs: number;

  constructor(
    private readonly location: S3Location,
    private readonly credentials: SigV4Credentials,
    options: S3ClientOptions = {}
  ) {
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.now = options.now ?? (() => new Date());
    this.timeoutMs = options.timeoutMs ?? S3_REQUEST_TIMEOUT_MS;
    this.transferTimeoutMs = options.transferTimeoutMs ?? S3_TRANSFER_TIMEOUT_MS;
  }

  /** The URL of an object (or of the bucket when key is undefined). */
  url(key?: string, query: Array<[string, string]> = []): URL {
    const endpoint = new URL(this.location.endpoint);
    const encodedKey = key === undefined ? "" : uriEncode(key, false);
    let origin: string;
    let path: string;
    if (this.location.pathStyle || isIpLiteral(endpoint.hostname)) {
      origin = endpoint.origin;
      path = `/${uriEncode(this.location.bucket)}${key === undefined ? "" : `/${encodedKey}`}`;
    } else {
      origin = `${endpoint.protocol}//${this.location.bucket}.${endpoint.host}`;
      path = `/${encodedKey}`;
    }
    const search = query.map(([name, value]) => `${uriEncode(name)}=${uriEncode(value)}`).join("&");
    const url = new URL(`${origin}${path}${search ? `?${search}` : ""}`);
    // The URL parser must not have rewritten the path (dot segments): the
    // signature covers it as built.
    if (url.pathname !== path) throw new S3Error("The object key cannot be used in a URL");
    return url;
  }

  private async send(
    method: "GET" | "PUT" | "DELETE",
    url: URL,
    options: { body?: Buffer; headers?: Record<string, string>; timeoutMs?: number } = {}
  ): Promise<Response> {
    const payloadHash = options.body ? sha256Hex(options.body) : EMPTY_PAYLOAD_SHA256;
    const signed = signV4({
      method,
      url,
      headers: { ...(options.headers ?? {}), "x-amz-content-sha256": payloadHash },
      payloadHash,
      region: this.location.region,
      service: "s3",
      credentials: this.credentials,
      date: this.now(),
    });
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    try {
      return await this.fetchImpl(url.toString(), {
        method,
        headers: signed.headers,
        body: options.body ? new Uint8Array(options.body) : undefined,
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new S3Error(describeNetworkError(error, timeoutMs));
    }
  }

  async putObject(key: string, body: Buffer, options: { contentType: string; metadata?: Record<string, string> }): Promise<void> {
    const headers: Record<string, string> = { "content-type": options.contentType };
    for (const [name, value] of Object.entries(options.metadata ?? {})) headers[`x-amz-meta-${name.toLowerCase()}`] = value;
    const response = await this.send("PUT", this.url(key), { body, headers, timeoutMs: this.transferTimeoutMs });
    if (response.status < 200 || response.status > 299) throw await errorFromResponse(response);
    await response.body?.cancel().catch(() => undefined);
  }

  async getObject(key: string, maxBytes: number): Promise<{ body: Buffer; metadata: Record<string, string> }> {
    const response = await this.send("GET", this.url(key), { timeoutMs: this.transferTimeoutMs });
    if (response.status !== 200) throw await errorFromResponse(response);
    const metadata: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      if (name.toLowerCase().startsWith("x-amz-meta-")) metadata[name.toLowerCase().slice("x-amz-meta-".length)] = value;
    });
    return { body: await readLimited(response, maxBytes, this.transferTimeoutMs), metadata };
  }

  /** Deletes an object; a missing object is not an error. */
  async deleteObject(key: string): Promise<void> {
    const response = await this.send("DELETE", this.url(key));
    if (response.status === 404) {
      await response.body?.cancel().catch(() => undefined);
      return;
    }
    if (response.status < 200 || response.status > 299) throw await errorFromResponse(response);
    await response.body?.cancel().catch(() => undefined);
  }

  /** Every object whose key starts with `prefix`, in the order the storage lists them. */
  async listObjects(prefix: string): Promise<{ objects: S3Object[]; complete: boolean }> {
    const objects: S3Object[] = [];
    let token: string | null = null;
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const query: Array<[string, string]> = [
        ["list-type", "2"],
        ["max-keys", String(LIST_PAGE_SIZE)],
        ["prefix", prefix],
      ];
      if (token) query.push(["continuation-token", token]);
      const response = await this.send("GET", this.url(undefined, query));
      if (response.status !== 200) throw await errorFromResponse(response);
      const result = parseListObjectsV2((await readLimited(response, MAX_LIST_RESPONSE_BYTES, this.timeoutMs)).toString("utf8"));
      objects.push(...result.objects);
      if (!result.isTruncated || !result.nextContinuationToken) return { objects, complete: true };
      token = result.nextContinuationToken;
    }
    return { objects, complete: false };
  }
}
