// SPDX-License-Identifier: Elastic-2.0
import { NextResponse } from "next/server";
import { ensureMonetizationLoaded } from "@/ee/monetization/engine";
import { handleStripeEvent, verifyStripeSignature } from "@/ee/monetization/payments";
import { readStripeSecrets } from "@/ee/monetization/settings";

/**
 * Stripe webhook of API monetization (the events in STRIPE_WEBHOOK_EVENTS:
 * Checkout payments and card setups, postpaid charges, refunds, disputes).
 * Public: the Stripe-Signature header is verified on the raw body before
 * anything is read from it.
 */

const MAX_BODY_BYTES = 512 * 1024;

export async function POST(request: Request): Promise<Response> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  }
  const raw = Buffer.from(await request.arrayBuffer());
  if (raw.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  }
  const { webhookSecret } = await readStripeSecrets();
  if (!webhookSecret) {
    return NextResponse.json({ error: "Stripe is not configured" }, { status: 503 });
  }
  if (!verifyStripeSignature(raw, request.headers.get("stripe-signature"), webhookSecret)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }
  let event: unknown;
  try {
    event = JSON.parse(raw.toString("utf8"));
  } catch {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }
  await ensureMonetizationLoaded();
  const outcome = await handleStripeEvent(event);
  // Not applicable yet (a refund whose payment could not be looked up): Stripe sends it again.
  if (!outcome.handled && outcome.retry) {
    return NextResponse.json({ error: "Try again later" }, { status: 503, headers: { "Retry-After": "60" } });
  }
  return NextResponse.json(
    outcome.handled ? { received: true, credited: !outcome.duplicate && outcome.amountMicros > 0 } : { received: true, ignored: outcome.reason }
  );
}
