// SPDX-License-Identifier: Elastic-2.0
/**
 * The license gate for paths that replace the whole configuration
 * (configuration import, backup restore, configuration history rollback):
 * like saving the setting, bringing in shared certificate storage that is
 * not already configured needs the license; keeping it, or going back to
 * local storage, never does. It runs inside the transaction that replaces
 * the configuration (see src/lib/config-replace.ts), with the license state
 * read before it.
 */
import { LicenseRequiredError } from "@/ee/licensing/store";
import { parseStoredCertificateStorage, storageChangeNeedsLicense } from "./settings";
import { HIGH_AVAILABILITY_FEATURE } from "./types";

/**
 * Throws CertificateStorageSettingError (400) when `nextValue` is not a valid
 * certificate storage setting, and LicenseRequiredError (403) when it sets up
 * or changes shared storage and `licensed` is false. `previousValue` is the
 * stored value being replaced; an invalid one counts as unset.
 */
export function assertCertificateStorageReplacementAllowed(previousValue: unknown, nextValue: unknown, licensed: boolean): void {
  const next = parseStoredCertificateStorage(nextValue);
  let previous;
  try {
    previous = parseStoredCertificateStorage(previousValue);
  } catch {
    previous = null;
  }
  if (!licensed && storageChangeNeedsLicense(previous, next)) {
    throw new LicenseRequiredError(HIGH_AVAILABILITY_FEATURE);
  }
}
