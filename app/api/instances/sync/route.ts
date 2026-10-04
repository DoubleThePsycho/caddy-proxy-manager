import { NextRequest, NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "crypto";
import { getInstanceMode, getSlaveMasterToken, type SyncPayload } from "@/src/lib/instance-sync";
import {
  SYNC_KEY_CHALLENGE_PARAM,
  SyncSealError,
  createSyncKeyResponse,
  type SyncPublicKeyResponse,
} from "@/src/lib/sync-crypto";
import { SYNC_STATUS_PARAM } from "@/src/lib/instance-sync-fingerprint";
import { buildReplicaSyncStatus } from "@/src/lib/instance-sync-status";
import { syncPayloadValidationError } from "@/src/lib/instance-sync-validation";
import { MAX_SYNC_BODY_BYTES, applyReceivedSyncPayload } from "@/src/lib/instance-sync-apply";
import { isPullReplicaMode } from "@/ee/fleet/pull-config";
import { getClientIp } from "@/src/lib/client-ip";
import { createRateLimiter, type RateLimiter } from "@/src/lib/rate-limit";
import { shareSyncNonce } from "@/src/lib/sync-nonces";
const SYNC_RATE_MAX = Number(process.env.INSTANCE_SYNC_RATE_MAX ?? 60);
const SYNC_RATE_WINDOW_MS = Number(process.env.INSTANCE_SYNC_RATE_WINDOW_MS ?? 60_000);
// Pre-authentication request limit per client address; every request counts.
// A fixed window: up to SYNC_RATE_MAX requests, then refusals until it ends,
// so a master syncing steadily at the limit is never refused. The master
// fetches the key before each sync, so key requests have a limiter of their
// own and do not use up the syncs.
const syncRateLimiter = createRateLimiter({
  name: "instance-sync",
  maxAttempts: SYNC_RATE_MAX,
  windowMs: SYNC_RATE_WINDOW_MS,
  blockMs: "window",
});
const keyRateLimiter = createRateLimiter({
  name: "instance-sync-key",
  maxAttempts: SYNC_RATE_MAX,
  windowMs: SYNC_RATE_WINDOW_MS,
  blockMs: "window",
});
// Status requests (drift checks and rollout health checks) count separately,
// so they never use up the key requests a sync needs.
const statusRateLimiter = createRateLimiter({
  name: "instance-sync-status",
  maxAttempts: SYNC_RATE_MAX,
  windowMs: SYNC_RATE_WINDOW_MS,
  blockMs: "window",
});

/**
 * Timing-safe token comparison to prevent timing attacks
 */
function secureTokenCompare(a: string, b: string): boolean {
  // Hash arbitrary UTF-8 input to fixed-size buffers before comparing. This
  // avoids both length-dependent comparisons and timingSafeEqual throwing when
  // a Unicode token's byte length differs from its JavaScript string length.
  const digestA = createHash("sha256").update(a, "utf8").digest();
  const digestB = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(digestA, digestB);
}

/**
 * Slave mode, the request limit and the master's bearer token. Returns the
 * refusal, or null when the request may proceed.
 */
async function refuseUnauthorizedSyncRequest(request: NextRequest, limiter: RateLimiter): Promise<NextResponse | null> {
  const mode = await getInstanceMode();
  if (mode !== "slave") {
    return NextResponse.json({ error: "Instance is not configured as a slave" }, { status: 403 });
  }
  // A pull replica (INSTANCE_SYNC_MODE=pull) only takes what it fetches
  // from its master itself; it is never pushed to.
  if (isPullReplicaMode()) {
    return NextResponse.json({ error: "Instance pulls its configuration from its master and accepts no pushes" }, { status: 403 });
  }

  const clientIp = getClientIp(request.headers);
  const rateLimit = await limiter.isRateLimited(clientIp);
  if (rateLimit.blocked) {
    const retryAfterSeconds = rateLimit.retryAfterMs ? Math.ceil(rateLimit.retryAfterMs / 1000) : 60;
    return NextResponse.json(
      { error: "Too many sync requests. Please retry later." },
      { status: 429, headers: { "Retry-After": retryAfterSeconds.toString() } }
    );
  }
  await limiter.registerAttempt(clientIp);

  const authHeader = request.headers.get("authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  const expected = await getSlaveMasterToken();

  if (!expected || !secureTokenCompare(token, expected)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}

/**
 * This slave's public key, which the master seals the secrets in the sync
 * payload to, and a single-use nonce for that payload (see
 * src/lib/sync-crypto.ts). Authenticated like the sync; the master fetches
 * both before every sync. With `?challenge=` (masters that pin slave keys
 * send one), the reply also carries a rotation proof from each key derived
 * from SESSION_SECRET_PREVIOUS; a challenge that is not a usable X25519
 * public key gets 400 and no nonce.
 *
 * With `?status=1` the reply is instead this slave's sync status
 * (`{ syncStatus }`, see src/lib/instance-sync-status.ts): the fingerprint of
 * the configuration it last applied, whether it changed here since, its
 * release and its last Caddy apply. No nonce is issued. Older releases
 * ignore the parameter and answer with their key, which the master reads as
 * "status unknown".
 */
export async function GET(request: NextRequest) {
  if (request.nextUrl.searchParams.get(SYNC_STATUS_PARAM) === "1") {
    const refusal = await refuseUnauthorizedSyncRequest(request, statusRateLimiter);
    if (refusal) return refusal;
    return NextResponse.json(await buildReplicaSyncStatus(), { headers: { "Cache-Control": "no-store" } });
  }
  const refusal = await refuseUnauthorizedSyncRequest(request, keyRateLimiter);
  if (refusal) return refusal;
  let body: SyncPublicKeyResponse;
  try {
    body = createSyncKeyResponse(request.nextUrl.searchParams.get(SYNC_KEY_CHALLENGE_PARAM));
  } catch (error) {
    if (!(error instanceof SyncSealError) || error.code !== "invalid_challenge") throw error;
    return NextResponse.json({ error: "Invalid sync key challenge" }, { status: 400 });
  }
  // The push may reach another replica of this instance.
  await shareSyncNonce(body.nonce);
  return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: NextRequest) {
  const refusal = await refuseUnauthorizedSyncRequest(request, syncRateLimiter);
  if (refusal) return refusal;

  let payload: unknown;
  try {
    const contentLength = request.headers.get("content-length");
    if (contentLength && Number.parseInt(contentLength, 10) > MAX_SYNC_BODY_BYTES) {
      return NextResponse.json({ error: "Sync payload too large" }, { status: 413 });
    }
    const bodyText = await request.text();
    if (bodyText.length > MAX_SYNC_BODY_BYTES) {
      return NextResponse.json({ error: "Sync payload too large" }, { status: 413 });
    }
    payload = JSON.parse(bodyText);
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload" }, { status: 400 });
  }

  // Structure, then the content checks (proxy hosts, L4 proxy hosts).
  const invalid = syncPayloadValidationError(payload);
  if (invalid) {
    return NextResponse.json({ error: invalid }, { status: 400 });
  }

  const result = await applyReceivedSyncPayload(payload as SyncPayload);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json({ ok: true });
}
