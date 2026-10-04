// SPDX-License-Identifier: Elastic-2.0
import { ed25519PublicKey, type TrustedFeedKeys } from "./feed";

/**
 * Keys whose signatures make a rule feed valid, by key id. They are not the
 * license keys: a feed is signed over its own context with its own keys, so
 * neither can stand in for the other. Rotating a key means adding the new
 * entry, signing feeds with it, and removing the old entry in a later
 * release. Create entries with ee/scripts/rule-feed-keygen.ts.
 *
 * Until the vendor's first key is added here, no feed verifies: every fetch
 * and import is refused with "signed by an unknown key", and nothing changes.
 */
const PRODUCTION_KEYS: ReadonlyArray<readonly [string, string]> = [];

function productionKeys(): TrustedFeedKeys {
  return new Map(PRODUCTION_KEYS.map(([kid, raw]) => [kid, ed25519PublicKey(raw)]));
}

let trustedKeys: TrustedFeedKeys = productionKeys();

export function getTrustedRuleFeedKeys(): TrustedFeedKeys {
  return trustedKeys;
}

/** Lets tests sign feeds with a throwaway key; refused outside tests. */
export function setTrustedRuleFeedKeysForTests(keys: TrustedFeedKeys | null): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Trusted rule feed keys can only be replaced in tests");
  }
  trustedKeys = keys ?? productionKeys();
}
