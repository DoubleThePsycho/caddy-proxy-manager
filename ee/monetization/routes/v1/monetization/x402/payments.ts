// SPDX-License-Identifier: Elastic-2.0
import { NextRequest, NextResponse } from "next/server";
import { requireApiPermission, apiErrorResponse } from "@/src/lib/api-auth";
import { ApiValidationError } from "@/src/lib/api-errors";
import { NO_STORE, readPageParam } from "@/ee/monetization/http";
import { listX402Payments, X402_PAYMENT_STATUSES, type X402PaymentStatus } from "@/ee/monetization/x402/payments";
import { parseRowId } from "@/src/lib/row-ids";

/** x402 payments, newest first: payer address, amount, transaction, Stripe PaymentIntent, state. ?hostId=&status=&page=&perPage= */
export async function GET(request: NextRequest) {
  try {
    await requireApiPermission(request, "monetization:read");
    const query = request.nextUrl.searchParams;
    const hostParam = query.get("hostId");
    const hostId = hostParam ? parseRowId(hostParam) : null;
    if (hostParam && hostId === null) throw new ApiValidationError("hostId must be a proxy host id");
    const status = query.get("status");
    if (status && !(X402_PAYMENT_STATUSES as readonly string[]).includes(status)) {
      throw new ApiValidationError(`status must be one of ${X402_PAYMENT_STATUSES.join(", ")}`);
    }
    return NextResponse.json(
      await listX402Payments({
        hostId,
        status: (status as X402PaymentStatus | null) ?? null,
        page: readPageParam(query.get("page"), 1, 100_000),
        perPage: readPageParam(query.get("perPage"), 50, 200),
      }),
      { headers: NO_STORE }
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}
