// SPDX-License-Identifier: Elastic-2.0
import { NextRequest } from "next/server";
import { getBrandingAsset } from "@/ee/white-label/store";
import { assetResponse } from "@/ee/white-label/http";
import { assetKindFromSlug } from "@/ee/white-label/types";

type Params = { params: Promise<{ asset: string }> };

/**
 * White-label logos and favicon (ee/white-label). Public: the sign-in pages
 * and the forward-auth portal show them before anyone signs in.
 */
export async function GET(request: NextRequest, { params }: Params) {
  const kind = assetKindFromSlug((await params).asset);
  return assetResponse(
    kind ? getBrandingAsset(kind) : null,
    request.nextUrl.searchParams.get("v"),
    request.headers.get("if-none-match")
  );
}
