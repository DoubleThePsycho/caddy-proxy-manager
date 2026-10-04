// SPDX-License-Identifier: Elastic-2.0
/**
 * The control mapping: which NIS2 measures and ISO/IEC 27001:2022 Annex A
 * controls each report and the incident notification drafts can serve as
 * evidence for. Kept in this one file so that it can be reviewed;
 * ee/docs/compliance-reports.md repeats it as a table, and
 * tests/unit/compliance-controls.test.ts keeps the two in step.
 *
 * The wording is deliberately conservative: a report is evidence that
 * supports a control, never proof that the control is met. Safe to import
 * from client components.
 */
import { BRAND_NAME } from "@/src/lib/brand";
import type { ControlReference, ReportType } from "./types";

/** NIS2 Directive (EU) 2022/2555, Article 21(2): the minimum risk-management measures. */
export const NIS2_MEASURES = {
  "Art. 21(2)(a)": "Policies on risk analysis and information system security",
  "Art. 21(2)(b)": "Incident handling",
  "Art. 21(2)(c)": "Business continuity, such as backup management and disaster recovery, and crisis management",
  "Art. 21(2)(d)": "Supply chain security",
  "Art. 21(2)(e)": "Security in network and information systems acquisition, development and maintenance, including vulnerability handling and disclosure",
  "Art. 21(2)(f)": "Policies and procedures to assess the effectiveness of cybersecurity risk-management measures",
  "Art. 21(2)(g)": "Basic cyber hygiene practices and cybersecurity training",
  "Art. 21(2)(h)": "Policies and procedures regarding the use of cryptography and, where appropriate, encryption",
  "Art. 21(2)(i)": "Human resources security, access control policies and asset management",
  "Art. 21(2)(j)": "Multi-factor or continuous authentication, secured voice, video and text communications and secured emergency communication systems",
  "Art. 23": "Reporting obligations (early warning, incident notification, final report)",
} as const;

export type Nis2Ref = keyof typeof NIS2_MEASURES;

/** ISO/IEC 27001:2022 Annex A controls referenced below. */
export const ISO27001_CONTROLS = {
  "A.5.5": "Contact with authorities",
  "A.5.9": "Inventory of information and other associated assets",
  "A.5.15": "Access control",
  "A.5.16": "Identity management",
  "A.5.18": "Access rights",
  "A.5.24": "Information security incident management planning and preparation",
  "A.5.25": "Assessment and decision on information security events",
  "A.5.26": "Response to information security incidents",
  "A.5.28": "Collection of evidence",
  "A.8.2": "Privileged access rights",
  "A.8.3": "Information access restriction",
  "A.8.5": "Secure authentication",
  "A.8.9": "Configuration management",
  "A.8.13": "Information backup",
  "A.8.15": "Logging",
  "A.8.16": "Monitoring activities",
  "A.8.20": "Networks security",
  "A.8.21": "Security of network services",
  "A.8.24": "Use of cryptography",
  "A.8.32": "Change management",
} as const;

export type IsoRef = keyof typeof ISO27001_CONTROLS;

type MappingEntry = { nis2: [Nis2Ref, string][]; iso27001: [IsoRef, string][] };

export type MappedSubject = ReportType | "incident_notification";

export const CONTROL_MAPPING: Record<MappedSubject, MappingEntry> = {
  access_review: {
    nis2: [
      ["Art. 21(2)(i)", "Lists every account with its role, permissions and status for a periodic review of access rights, and flags inactive accounts and unused API tokens."],
      ["Art. 21(2)(j)", "Shows which accounts use multi-factor authentication and flags administrators without it."],
    ],
    iso27001: [
      ["A.5.15", "Records who can use the reverse proxy's management dashboard and API, and with which permissions."],
      ["A.5.16", "Lists every dashboard identity, its status and its linked SSO identities."],
      ["A.5.18", "Supports the periodic review of access rights: roles, tag scopes, API tokens and group memberships."],
      ["A.8.2", "Identifies administrators and administrator-level roles."],
      ["A.8.5", "Shows MFA enrolment and the sign-in methods of each account."],
    ],
  },
  change_log: {
    nis2: [
      ["Art. 21(2)(b)", "A tamper-evident record of who changed what and when, as input to incident investigation."],
      ["Art. 21(2)(e)", "Records maintenance changes to the reverse proxy's configuration."],
    ],
    iso27001: [
      ["A.8.15", "Audit events of the period, with the result of the audit log's hash-chain verification."],
      ["A.8.32", "Lists changes by area and actor, for review against approved changes."],
      ["A.8.9", "Shows changes to the configuration of hosts, certificates and security settings."],
      ["A.5.28", "The report is hashed and its generation recorded in the hash-chained audit log, which helps preserve it as evidence."],
    ],
  },
  certificate_inventory: {
    nis2: [
      ["Art. 21(2)(h)", "Inventory of TLS server, CA and client certificates with issuer, key type and expiry."],
      ["Art. 21(2)(i)", "Certificates and the hosts that use them, as managed assets."],
    ],
    iso27001: [
      ["A.8.24", "Shows key types, issuers, validity and revocation, as input to key lifecycle management."],
      ["A.5.9", "Inventory of certificates and where they are used."],
    ],
  },
  protection_coverage: {
    nis2: [
      ["Art. 21(2)(f)", "Shows coverage gaps (hosts without WAF, authentication or HSTS) as input to assessing the effectiveness of the measures."],
      ["Art. 21(2)(h)", "Shows HTTPS redirects, HSTS and upstream TLS verification per host."],
      ["Art. 21(2)(i)", "Shows which hosts are protected by access lists, forward auth or mTLS."],
      ["Art. 21(2)(j)", "Shows the MFA coverage of dashboard users."],
    ],
    iso27001: [
      ["A.8.20", "Shows which published hosts are behind the WAF and geo blocking."],
      ["A.8.21", "Lists the security mechanisms of each published web service: WAF, authentication and TLS."],
      ["A.8.3", "Hosts whose access is restricted by access lists, forward auth or mTLS."],
      ["A.8.5", "MFA coverage of dashboard users and authentication in front of hosts."],
      ["A.8.24", "HTTPS redirects, HSTS and upstream TLS verification per host."],
    ],
  },
  traffic_questions: {
    nis2: [
      ["Art. 21(2)(f)", "Re-runs the chosen traffic questions for every period, so trends in requests, errors and mitigated requests can be reviewed as input to assessing the measures."],
      ["Art. 21(2)(b)", "Keeps aggregated traffic figures of each period, a baseline when investigating incidents."],
    ],
    iso27001: [
      ["A.8.16", "Documents a recurring review of the traffic of published web services, from aggregated figures only."],
      ["A.5.28", "The figures are stored in a hashed report whose generation is recorded in the hash-chained audit log."],
    ],
  },
  incident_notification: {
    nis2: [
      ["Art. 21(2)(b)", "Structured preparation of incident notifications from collected facts."],
      ["Art. 23", "Drafts of the early warning, incident notification and final report, with their deadlines."],
    ],
    iso27001: [
      ["A.5.5", "Records when each notification was submitted to the CSIRT or authority, with its reference."],
      ["A.5.24", "A prepared, deadline-tracked notification workflow."],
      ["A.5.25", "Collects aggregated facts (WAF, traffic, alerts, changes) that support assessing the event."],
      ["A.5.26", "Supports the communication part of the incident response."],
    ],
  },
};

export const COMPLIANCE_STATEMENT =
  `This report is evidence that can support the controls listed with it. It does not by itself show compliance with NIS2, ` +
  `its national transpositions (in Italy D.Lgs. 138/2024) or ISO/IEC 27001: those also depend on policies, processes and ` +
  `systems outside ${BRAND_NAME}, and on how this evidence is reviewed and acted on.`;

/** The controls a report or the incident drafts support, NIS2 first. */
export function controlsFor(subject: MappedSubject): ControlReference[] {
  const entry = CONTROL_MAPPING[subject];
  return [
    ...entry.nis2.map(([ref, how]) => ({ framework: "NIS2" as const, ref, title: NIS2_MEASURES[ref], how })),
    ...entry.iso27001.map(([ref, how]) => ({ framework: "ISO/IEC 27001:2022" as const, ref, title: ISO27001_CONTROLS[ref], how })),
  ];
}

export type ControlMappingView = {
  statement: string;
  nis2Measures: { ref: string; title: string }[];
  iso27001Controls: { ref: string; title: string }[];
  mapping: Record<MappedSubject, ControlReference[]>;
};

/** The whole mapping, for GET /api/v1/compliance/controls and the dashboard. */
export function describeControlMapping(): ControlMappingView {
  return {
    statement: COMPLIANCE_STATEMENT,
    nis2Measures: Object.entries(NIS2_MEASURES).map(([ref, title]) => ({ ref, title })),
    iso27001Controls: Object.entries(ISO27001_CONTROLS).map(([ref, title]) => ({ ref, title })),
    mapping: Object.fromEntries(
      (Object.keys(CONTROL_MAPPING) as MappedSubject[]).map((subject) => [subject, controlsFor(subject)])
    ) as Record<MappedSubject, ControlReference[]>,
  };
}
