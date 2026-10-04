#!/usr/bin/env bun
// SPDX-License-Identifier: Elastic-2.0
/**
 * Builds and signs the rule feed from a directory of pack files (one JSON
 * file per pack, in the format of ee/rule-feed/types.ts RulePack).
 *
 *   bun ee/scripts/rule-feed-sign.ts --key ~/.config/ingressi/rule-feed-signing-2026-10.pem \
 *     --kid 2026-10 --packs ./packs [--sequence 1791300000] [--days 30] [--out feed.json] [--allow-examples]
 *
 * Every pack is validated exactly as installs validate it (schema, SecLang
 * allowlist, reserved rule ids, unique ids across the feed), and its sample
 * requests are checked against its rules with an approximate evaluator
 * (ee/rule-feed/sample-check.ts): a positive sample its rules do not match,
 * or a negative one they do, stops the build. Packs marked "example" are
 * refused unless --allow-examples is given, so the examples in
 * ee/rule-feed/examples never reach a production feed by accident.
 *
 * --sequence defaults to the current Unix time in seconds, which increases
 * with every build; installs refuse a feed whose sequence is not higher than
 * the installed one. The finished feed is verified with the public half of
 * the key before it is written. Nothing is uploaded: publish the file as a
 * static file (see ee/docs/rule-feed-publishing.md).
 */
import { createPrivateKey, createPublicKey, sign } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { feedDocument, feedSigningInput, parseRuleFeedPayload, RuleFeedError, verifyRuleFeed } from "../rule-feed/feed";
import { checkPackSamples } from "../rule-feed/sample-check";
import { RULE_FEED_LIMITS } from "../rule-feed/types";

const { values } = parseArgs({
  options: {
    key: { type: "string" },
    kid: { type: "string" },
    packs: { type: "string" },
    sequence: { type: "string" },
    days: { type: "string" },
    out: { type: "string" },
    "allow-examples": { type: "boolean", default: false },
  },
});

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const home = (path: string) => resolve(path.replace(/^~(?=\/)/, homedir()));

if (!values.key || !values.kid || !values.packs) fail("--key, --kid and --packs are required");
const days = Number(values.days ?? "30");
if (!Number.isInteger(days) || days < 1 || days > RULE_FEED_LIMITS.maxValidityDays) fail(`--days must be 1-${RULE_FEED_LIMITS.maxValidityDays}`);
const now = new Date();
const sequence = Number(values.sequence ?? Math.floor(now.getTime() / 1000));
if (!Number.isSafeInteger(sequence) || sequence < 1) fail("--sequence must be a positive integer");

const directory = home(values.packs);
const files = readdirSync(directory).filter((name) => name.endsWith(".json")).sort();
if (files.length === 0) fail(`${directory} has no .json pack files`);

const packs: unknown[] = [];
for (const file of files) {
  let pack: unknown;
  try {
    pack = JSON.parse(readFileSync(join(directory, file), "utf8"));
  } catch {
    fail(`${file}: not valid JSON`);
  }
  if (typeof pack === "object" && pack !== null && (pack as { example?: unknown }).example === true && !values["allow-examples"]) {
    fail(`${file}: an example pack; pass --allow-examples to sign it (never for a production feed)`);
  }
  packs.push(pack);
}

const payload = { v: 1, kid: values.kid, sequence, issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + days * 86_400_000).toISOString(), packs };
let parsed: ReturnType<typeof parseRuleFeedPayload>;
try {
  parsed = parseRuleFeedPayload(payload);
} catch (error) {
  fail(error instanceof RuleFeedError ? error.message : String(error));
}

let problems = 0;
for (const { pack } of parsed.packs) {
  const check = checkPackSamples(pack);
  for (const problem of check.problems) {
    console.error(`${pack.id}: ${problem}`);
    problems++;
  }
  for (const unchecked of check.unchecked) console.warn(`${pack.id}: could not check ${unchecked}; test it against Coraza`);
}
if (problems > 0) fail(`${problems} sample(s) contradict their rules; nothing was signed`);

const privateKey = createPrivateKey(readFileSync(home(values.key)));
const payloadPart = Buffer.from(JSON.stringify(parsed.payload), "utf8").toString("base64url");
const document = feedDocument(payloadPart, sign(null, feedSigningInput(payloadPart), privateKey));
try {
  verifyRuleFeed(document, new Map([[values.kid, createPublicKey(privateKey)]]), now);
} catch (error) {
  fail(`The signed feed does not verify: ${error instanceof Error ? error.message : String(error)}`);
}

if (values.out) {
  writeFileSync(home(values.out), document);
  console.error(`Feed sequence ${sequence}, ${parsed.packs.length} pack(s), expires ${payload.expiresAt}: ${home(values.out)}`);
} else {
  process.stdout.write(document);
}
