// SPDX-License-Identifier: Elastic-2.0
import { EDITION_LABELS, FEATURE_INFO, FEATURES, isFeatureAvailable, type Edition, type Feature } from "./features";
import { canConfigure, type LicenseState, type LicenseStatus } from "./license";

export type LicenseFeatureView = {
  id: Feature;
  label: string;
  description: string;
  edition: Edition;
  editionLabel: string;
  /** Shipped in this release (some paid features are still on the roadmap). */
  available: boolean;
  /** Granted by the installed license. */
  included: boolean;
  /** Administrators may set it up or change it now (never while it is coming soon). */
  configurable: boolean;
};

export type LicenseView = {
  status: LicenseStatus;
  edition: Edition | null;
  editionLabel: string | null;
  customer: string | null;
  email: string | null;
  licenseId: string | null;
  /** Id of the public key, built into this release, that the key's signature was checked with. */
  keyId: string | null;
  trial: boolean;
  issuedAt: string | null;
  expiresAt: string | null;
  graceEndsAt: string | null;
  nodes: { licensed: number | null; used: number; overLimit: boolean };
  error: string | null;
  features: LicenseFeatureView[];
};

/** JSON-safe description of the license for the API and the dashboard; never includes the key. */
export function toLicenseView(state: LicenseState, nodesUsed: number): LicenseView {
  const license = state.license;
  const licensed = license?.nodes ?? null;
  return {
    status: state.status,
    edition: license?.edition ?? null,
    editionLabel: license ? EDITION_LABELS[license.edition] : null,
    customer: license?.customer ?? null,
    email: license?.email ?? null,
    licenseId: license?.id ?? null,
    keyId: license?.kid ?? null,
    trial: license?.trial === true,
    issuedAt: license?.iat ?? null,
    expiresAt: license?.exp ?? null,
    graceEndsAt: state.graceEndsAt,
    nodes: { licensed, used: nodesUsed, overLimit: licensed !== null && nodesUsed > licensed },
    error: state.error,
    features: FEATURES.map((id) => {
      const info = FEATURE_INFO[id];
      return {
        id,
        label: info.label,
        description: info.description,
        edition: info.edition,
        editionLabel: EDITION_LABELS[info.edition],
        available: isFeatureAvailable(id),
        included: state.features.includes(id),
        configurable: isFeatureAvailable(id) && canConfigure(state, id),
      };
    }),
  };
}

/**
 * What a key would grant, checked on this machine without storing it (the
 * install form's verify step and POST /api/v1/license/verify). Never
 * includes the key.
 */
export type LicenseKeyCheck = {
  /** The signature is valid and the key is not past its grace period: installing it would succeed. */
  installable: boolean;
  /** The key's state if it were installed now; "invalid" covers malformed, unsigned and not-yet-valid keys. */
  status: Exclude<LicenseStatus, "unlicensed">;
  /** Why the key cannot be installed; safe to show. */
  error: string | null;
  keyId: string | null;
  licenseId: string | null;
  edition: Edition | null;
  editionLabel: string | null;
  customer: string | null;
  email: string | null;
  trial: boolean;
  issuedAt: string | null;
  expiresAt: string | null;
  graceEndsAt: string | null;
  /** Nodes the key covers. */
  nodes: number | null;
  /** Paid features the key grants: its edition's plus any added to it. */
  features: Feature[];
};

/** JSON-safe description of a checked key; `error` is the reason it cannot be installed. */
export function toLicenseKeyCheck(state: LicenseState, installable: boolean, error: string | null): LicenseKeyCheck {
  const license = state.license;
  return {
    installable,
    status: state.status === "unlicensed" ? "invalid" : state.status,
    error,
    keyId: license?.kid ?? null,
    licenseId: license?.id ?? null,
    edition: license?.edition ?? null,
    editionLabel: license ? EDITION_LABELS[license.edition] : null,
    customer: license?.customer ?? null,
    email: license?.email ?? null,
    trial: license?.trial === true,
    issuedAt: license?.iat ?? null,
    expiresAt: license?.exp ?? null,
    graceEndsAt: state.graceEndsAt,
    nodes: license?.nodes ?? null,
    features: [...state.features],
  };
}
