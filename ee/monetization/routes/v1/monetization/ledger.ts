// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { ApiValidationError } from "@/src/lib/api-errors";
import { NO_STORE, readPageParam } from "@/ee/monetization/http";
import { listLedger } from "@/ee/monetization/ledger";
import { LEDGER_TYPES, type LedgerType } from "@/ee/monetization/types";

/** ?consumerId=&type=topup|usage|adjustment|credit|payment|refund|dispute&page=&perPage= (newest first). */
export async function GET(request: NextRequest) {
  try {
    await requireApiPermission(request, "monetization:read");
    const query = request.nextUrl.searchParams;
    const consumerParam = query.get("consumerId");
    const consumerId = consumerParam ? Number(consumerParam) : null;
    if (consumerId !== null && (!Number.isSafeInteger(consumerId) || consumerId < 1)) {
      throw new ApiValidationError("consumerId must be a consumer id");
    }
    const typeParam = query.get("type");
    if (typeParam && !(LEDGER_TYPES as readonly string[]).includes(typeParam)) {
      throw new ApiValidationError(`type must be one of ${LEDGER_TYPES.join(", ")}`);
    }
    const page = await listLedger({
      consumerId,
      type: (typeParam as LedgerType | null) ?? null,
      page: readPageParam(query.get("page"), 1, 100_000),
      perPage: readPageParam(query.get("perPage"), 50, 200),
    });
    return NextResponse.json(page, { headers: NO_STORE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
