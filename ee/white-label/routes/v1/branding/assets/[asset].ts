// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse, NotFoundError } from "@/src/lib/api-auth";
import { deleteBrandingAsset, uploadBrandingAsset } from "@/ee/white-label/service";
import { readUploadRequest } from "@/ee/white-label/http";
import { assetKindFromSlug, type AssetKind } from "@/ee/white-label/types";

const NO_STORE = { "Cache-Control": "no-store" };

type Params = { params: Promise<{ asset: string }> };

async function kindFrom({ params }: Params): Promise<AssetKind> {
  const kind = assetKindFromSlug((await params).asset);
  if (!kind) throw new NotFoundError("Unknown asset: use logo-light, logo-dark or favicon");
  return kind;
}

/**
 * Uploads a logo or the favicon: multipart/form-data with a "file" field, or
 * the image as the body. Needs the license.
 */
export async function PUT(request: NextRequest, context: Params) {
  try {
    const { userId } = await requireApiPermission(request, "branding:write");
    const kind = await kindFrom(context);
    return NextResponse.json(await uploadBrandingAsset(kind, await readUploadRequest(request), userId), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

/** Removes a logo or the favicon. Never needs a license. */
export async function DELETE(request: NextRequest, context: Params) {
  try {
    const { userId } = await requireApiPermission(request, "branding:write");
    const kind = await kindFrom(context);
    return NextResponse.json(await deleteBrandingAsset(kind, userId), { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
