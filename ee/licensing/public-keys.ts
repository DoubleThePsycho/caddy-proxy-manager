// SPDX-License-Identifier: Elastic-2.0
import { ed25519PublicKey, type TrustedKeys } from "./license";

/**
 * Keys whose signatures make a license valid, by key id. Rotating a key means
 * adding the new entry and keeping the old one until every license it signed
 * has expired. Create entries with ee/scripts/license-keygen.ts.
 */
const PRODUCTION_KEYS: ReadonlyArray<readonly [string, string]> = [
  ["2026-10", "pEKLE0vZErMaAXqW9QJvRY_iu-cLt3ba2Ev83yWsdww"],
  // The license server's online key: purchases, renewals and trials.
  ["online-2026-10", "9ztRfuuCIybTYRT_oAq5Fuvyy4JjPFXPn2jI3pyjaNw"],
];

let trustedKeys: TrustedKeys = new Map(PRODUCTION_KEYS.map(([kid, raw]) => [kid, ed25519PublicKey(raw)]));

export function getTrustedLicenseKeys(): TrustedKeys {
  return trustedKeys;
}

/** Lets tests sign licenses with a throwaway key; refused outside tests. */
export function setTrustedLicenseKeysForTests(keys: TrustedKeys | null): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Trusted license keys can only be replaced in tests");
  }
  trustedKeys = keys ?? new Map(PRODUCTION_KEYS.map(([kid, raw]) => [kid, ed25519PublicKey(raw)]));
}
