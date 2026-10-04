// SPDX-License-Identifier: Elastic-2.0
import type { SamlRole } from "./constants";

/** One entry of a provider's group-to-role mapping. */
export type SamlGroupRoleMapping = { group: string; role: SamlRole };

/** A provider as sign-in uses it, with the SP signing key decrypted. Never leaves the server. */
export type SamlProviderConfig = {
  id: number;
  name: string;
  enabled: boolean;
  idpEntityId: string;
  idpSsoUrl: string;
  /** PEM certificates any of which may sign responses. */
  idpCertificates: string[];
  /** PEM private key that signs AuthnRequests, or null for unsigned requests. */
  spPrivateKey: string | null;
  spCertificate: string | null;
  subjectAttribute: string | null;
  emailAttribute: string;
  nameAttribute: string | null;
  groupsAttribute: string | null;
  groupRoleMappings: SamlGroupRoleMapping[];
  defaultRole: "user" | "viewer";
  requiredGroup: string | null;
  provisionUsers: boolean;
  linkExistingAccounts: boolean;
};

/** The SP side of a provider: all derived from BASE_URL and the provider id. */
export type SamlServiceProviderUrls = {
  entityId: string;
  acsUrl: string;
  metadataUrl: string;
};

export type SamlCertificateSummary = {
  subject: string;
  issuer: string;
  notBefore: string;
  notAfter: string;
  /** SHA-256 fingerprint, colon-separated hex. */
  fingerprint: string;
  expired: boolean;
};

/** What the API and the dashboard show of a provider: everything but the SP private key. */
export type SamlProviderView = Omit<SamlProviderConfig, "spPrivateKey"> & {
  hasSpPrivateKey: boolean;
  /** AuthnRequests are signed (the provider has an SP signing key). */
  signsRequests: boolean;
  certificates: SamlCertificateSummary[];
  sp: SamlServiceProviderUrls;
  /** Accounts signed in through this provider (rows in `accounts`). */
  linkedAccounts: number;
  /** Settings worth a second look. */
  warnings: string[];
  createdAt: string;
  updatedAt: string;
};

/** The identity a verified assertion carries, with the attributes as sent. */
export type SamlAssertionIdentity = {
  assertionId: string;
  issuer: string;
  nameId: string | null;
  nameIdFormat: string | null;
  /** Attribute name to its values, in document order. */
  attributes: Map<string, string[]>;
  /** Until when the assertion could still be accepted (with clock skew): how long its ID is remembered. */
  replayUntil: number;
};
