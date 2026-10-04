#!/usr/bin/env bun
// SPDX-License-Identifier: Elastic-2.0
/**
 * Signs a license key.
 *
 *   bun ee/scripts/license-sign.ts --key ~/.config/ingressi/license-signing-2026-10.pem \
 *     --kid 2026-10 --customer "Example S.r.l." --edition business --nodes 3 --days 365 \
 *     [--email it@example.com] [--id LIC-0001] [--trial] [--feature approvals ...]
 *
 * Prints the key on stdout; nothing is stored.
 */
import { createPrivateKey, randomUUID, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import { LICENSE_VERSION, parseLicensePayload, signingInput } from "../licensing/license";

const { values } = parseArgs({
  options: {
    key: { type: "string" },
    kid: { type: "string" },
    customer: { type: "string" },
    email: { type: "string" },
    edition: { type: "string" },
    nodes: { type: "string" },
    days: { type: "string" },
    id: { type: "string" },
    trial: { type: "boolean", default: false },
    feature: { type: "string", multiple: true },
  },
});

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

if (!values.key || !values.kid || !values.customer || !values.edition) {
  fail("--key, --kid, --customer and --edition are required");
}
const days = Number(values.days ?? (values.trial ? "14" : "365"));
if (!Number.isInteger(days) || days < 1 || days > 3660) fail("--days must be 1-3660");

const now = new Date();
const payload = parseLicensePayload({
  v: 1,
  kid: values.kid,
  id: values.id ?? `LIC-${randomUUID().slice(0, 8).toUpperCase()}`,
  customer: values.customer,
  ...(values.email ? { email: values.email } : {}),
  edition: values.edition,
  nodes: Number(values.nodes ?? "1"),
  ...(values.feature?.length ? { features: values.feature } : {}),
  ...(values.trial ? { trial: true } : {}),
  iat: now.toISOString(),
  exp: new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString(),
});

const privateKey = createPrivateKey(readFileSync(values.key.replace(/^~(?=\/)/, homedir())));
const payloadPart = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
const signature = sign(null, signingInput(payloadPart), privateKey).toString("base64url");
process.stdout.write(`${LICENSE_VERSION}.${payloadPart}.${signature}\n`);
