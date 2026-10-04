// SPDX-License-Identifier: Elastic-2.0
/**
 * White-label HTTP helpers: reading an upload with a size cap, and serving a
 * stored logo or favicon to anyone (sign-in pages need them before sign-in).
 */
import { ApiClientError, ApiValidationError } from "@/src/lib/api-errors";
import type { LoadedAsset } from "./store";
import { MAX_ASSET_BYTES } from "./types";
import type { BrandingUpload } from "./service";

/** Room for the multipart envelope around the largest accepted file. */
const MAX_BODY_BYTES = MAX_ASSET_BYTES + 64 * 1024;

class PayloadTooLargeError extends ApiClientError {
  constructor() {
    super(`The upload is larger than ${Math.round(MAX_ASSET_BYTES / 1024)} KB`, 413);
    this.name = "PayloadTooLargeError";
  }
}

/** The request body, refused with 413 as soon as it passes `limit` bytes. */
async function readCapped(request: Request, limit: number): Promise<Buffer> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) throw new PayloadTooLargeError();
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw new PayloadTooLargeError();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/**
 * An upload from a REST request: multipart/form-data with the image in a
 * "file" field, or the image itself as the body (any other content type).
 */
export async function readUploadRequest(request: Request): Promise<BrandingUpload> {
  const contentType = request.headers.get("content-type") ?? "";
  const body = await readCapped(request, MAX_BODY_BYTES);
  if (!/^multipart\/form-data/i.test(contentType)) {
    return { data: body, fileName: null, declaredType: contentType.split(";")[0].trim() || null };
  }
  let form: FormData;
  try {
    form = await new Response(new Uint8Array(body), { headers: { "content-type": contentType } }).formData();
  } catch {
    throw new ApiValidationError("The multipart body could not be read");
  }
  return readUploadForm(form);
}

/** An upload from form data (the dashboard's server action, or a parsed multipart body). */
export async function readUploadForm(form: FormData): Promise<BrandingUpload> {
  const file = form.get("file");
  if (!file || typeof file === "string") throw new ApiValidationError('Send the image in a "file" field');
  if (file.size > MAX_ASSET_BYTES) throw new PayloadTooLargeError();
  return { data: new Uint8Array(await file.arrayBuffer()), fileName: file.name || null, declaredType: file.type || null };
}

const ASSET_FILE_NAMES: Record<LoadedAsset["type"], string> = {
  "image/png": "image.png",
  "image/jpeg": "image.jpg",
  "image/webp": "image.webp",
  "image/x-icon": "favicon.ico",
};

/**
 * The response for a stored asset. A request carrying the current version
 * (?v=) may be cached for a year; any other is revalidated with the ETag, so
 * a new upload shows at once. The headers keep a browser from treating the
 * bytes as anything but an image.
 */
export function assetResponse(asset: LoadedAsset | null, requestedVersion: string | null, ifNoneMatch: string | null): Response {
  const common = {
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; sandbox",
    "Cross-Origin-Resource-Policy": "same-origin",
  };
  if (!asset) {
    return new Response("Not found", { status: 404, headers: { ...common, "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
  }
  const etag = `"${asset.version}"`;
  const headers = {
    ...common,
    ETag: etag,
    "Cache-Control": requestedVersion === asset.version ? "public, max-age=31536000, immutable" : "no-cache",
    "Content-Disposition": `inline; filename="${ASSET_FILE_NAMES[asset.type]}"`,
  };
  if (ifNoneMatch && ifNoneMatch.split(",").some((tag) => tag.trim().replace(/^W\//, "") === etag)) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(new Uint8Array(asset.data), {
    status: 200,
    headers: { ...headers, "Content-Type": asset.type, "Content-Length": String(asset.data.length) },
  });
}
