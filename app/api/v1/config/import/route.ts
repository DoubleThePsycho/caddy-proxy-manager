import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission } from "@/src/lib/api-auth";
import { ApiClientError, ApiValidationError } from "@/src/lib/api-errors";
import { configurationErrorResponse } from "@/src/lib/config-api";
import { importConfiguration, MAX_IMPORT_BYTES } from "@/src/lib/config-transfer";
import { beforeImportSnapshotHook } from "@/ee/config-history/snapshots";

/** The file and passphrase from a multipart form or a JSON body. */
async function readImportRequest(request: NextRequest): Promise<{ file: unknown; passphrase: unknown }> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_IMPORT_BYTES + 64 * 1024) {
    throw new ApiClientError(`The file is larger than ${MAX_IMPORT_BYTES / (1024 * 1024)} MiB`, 413);
  }
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("multipart/form-data")) {
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      throw new ApiValidationError("Request body must be a multipart form with file and passphrase");
    }
    const file = form.get("file");
    const passphrase = form.get("passphrase");
    if (file === null) throw new ApiValidationError("The form must include a file");
    if (typeof file !== "string" && file.size > MAX_IMPORT_BYTES) {
      throw new ApiClientError(`The file is larger than ${MAX_IMPORT_BYTES / (1024 * 1024)} MiB`, 413);
    }
    return { file: typeof file === "string" ? file : await file.text(), passphrase };
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new ApiValidationError("Request body must be JSON {passphrase, file} or a multipart form");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ApiValidationError("Request body must be JSON {passphrase, file}");
  }
  const { file, passphrase } = body as { file?: unknown; passphrase?: unknown };
  if (file === undefined) throw new ApiValidationError("file is required");
  return { file, passphrase };
}

export async function POST(request: NextRequest) {
  try {
    const { userId } = await requireApiPermission(request, "config:import");
    const { file, passphrase } = await readImportRequest(request);
    // Configuration history (when enabled) keeps the configuration this replaces.
    const saved = { snapshotId: null as number | null };
    const result = await importConfiguration({
      file,
      passphrase,
      userId,
      beforeWrite: beforeImportSnapshotHook(userId, saved),
    });
    return NextResponse.json({ ok: true, ...result, beforeSnapshotId: saved.snapshotId });
  } catch (error) {
    return configurationErrorResponse(error);
  }
}
