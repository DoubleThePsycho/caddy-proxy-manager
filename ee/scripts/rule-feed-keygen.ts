#!/usr/bin/env bun
// SPDX-License-Identifier: Elastic-2.0
/**
 * Creates an Ed25519 key pair for signing the rule feed (virtual patching).
 * Feed keys are separate from license keys: a feed signature covers its own
 * context, and a leaked feed key cannot issue licenses (or the reverse).
 *
 *   bun ee/scripts/rule-feed-keygen.ts --kid 2026-10 [--out ~/.config/ingressi]
 *
 * The private key is written with mode 0600 and must never enter the
 * repository; keep a copy in a password manager. Paste the printed public key
 * into ee/rule-feed/public-keys.ts.
 */
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    kid: { type: "string" },
    out: { type: "string" },
  },
});

const kid = values.kid?.trim();
if (!kid || !/^[A-Za-z0-9._-]{1,64}$/.test(kid)) {
  console.error("--kid is required: 1-64 characters of A-Z a-z 0-9 . _ -");
  process.exit(1);
}

const outDir = resolve((values.out ?? join(homedir(), ".config", "ingressi")).replace(/^~(?=\/)/, homedir()));
const keyPath = join(outDir, `rule-feed-signing-${kid}.pem`);
if (existsSync(keyPath)) {
  console.error(`${keyPath} already exists; choose another --kid`);
  process.exit(1);
}

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
mkdirSync(outDir, { recursive: true, mode: 0o700 });
writeFileSync(keyPath, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600, flag: "wx" });

const jwk = publicKey.export({ format: "jwk" });
console.log(`Private key: ${keyPath} (mode 0600, back it up in a password manager)`);
console.log("Add this entry to PRODUCTION_KEYS in ee/rule-feed/public-keys.ts:");
console.log(`  ["${kid}", "${jwk.x}"],`);
