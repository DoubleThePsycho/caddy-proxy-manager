// SPDX-License-Identifier: Elastic-2.0
/**
 * The impact of a change request, for the people who approve it: which host
 * it changes (a request always changes exactly one), whether Caddy reloads
 * and on how many nodes, which new certificates Caddy will request, whether
 * L4 listening ports change, and when the change applies given the change
 * windows of the policies that cover it. Pure apart from the reach, which the
 * caller passes in.
 */
import { isIP } from "node:net";
import type { ConfigurationReach } from "@/ee/fleet/reach";
import { TARGET_LABELS, type Operation, type RequestStatus, type TargetType, type WindowStatus } from "./types";

export type ChangeImpact = {
  hosts: { type: TargetType; id: number | null; name: string; domains: string[]; change: "create" | "update" | "delete"; operations: Operation[] }[];
  /** Hosts other than the target that change: always 0 (a request changes one host). */
  otherHosts: number;
  caddy: {
    /** Applying the change makes Caddy load a new configuration. */
    reloads: boolean;
    /** This node plus the instances the change is synced to. */
    nodes: number;
    instances: string[];
    /** Instances in promotion-only environments: they get it only when a revision is promoted. */
    heldBack: string[];
    /** Domains Caddy will request a certificate for (new domains of a host without an imported certificate). */
    certificateRequests: string[];
    /** L4 listening ports change: they must be applied separately (the Caddy container restarts). */
    l4PortsChange: boolean;
  };
  schedule: {
    /**
     * on_approval: applied as soon as it has its approvals; next_window: at
     * the next change window after approval; now: approved and the window is
     * open; waiting: approved, waiting for the window; done: applied, or
     * closed without being applied.
     */
    state: "on_approval" | "next_window" | "now" | "waiting" | "done";
    /** When it applies (the window opening), when known. */
    at: string | null;
    windows: string | null;
    description: string;
  };
  /** One-line summaries, in the order the dashboard shows them. */
  lines: { key: "hosts" | "caddy" | "when"; text: string }[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").map((item) => item.trim().toLowerCase()).filter(Boolean) : [];
}

function hasManagedCertificate(host: Record<string, unknown>): boolean {
  return host.certificateId === null || host.certificateId === undefined;
}

function needsPublicCertificate(domain: string): boolean {
  return !isIP(domain) && domain !== "localhost" && !domain.endsWith(".localhost") && !domain.endsWith(".local") && !domain.endsWith(".internal");
}

function formatWhen(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

export function computeChangeImpact(input: {
  targetType: TargetType;
  targetId: number | null;
  targetName: string;
  operation: Operation;
  operations: Operation[];
  status: RequestStatus;
  /** The validated change (input.host for the host's fields). */
  change: Record<string, unknown>;
  /** The host as it was when requested (null for a create). */
  base: Record<string, unknown> | null;
  window: WindowStatus;
  appliedAt: string | null;
  reach: ConfigurationReach;
}): ChangeImpact {
  const kind = input.operation === "create" ? "create" : input.operation === "delete" ? "delete" : "update";
  const requested = isRecord(input.change.host) ? input.change.host : {};
  const before = isRecord(input.base?.host) ? (input.base!.host as Record<string, unknown>) : {};
  const after = kind === "delete" ? {} : { ...before, ...requested };
  const domainsBefore = stringList(before.domains);
  const domainsAfter = stringList(after.domains);
  const domains = kind === "delete" ? domainsBefore : domainsAfter.length > 0 ? domainsAfter : domainsBefore;

  const certificateRequests =
    input.targetType === "proxy_host" && kind !== "delete" && after.enabled !== false && hasManagedCertificate(after)
      ? domainsAfter.filter((domain) => !domainsBefore.includes(domain) || (kind === "update" && !hasManagedCertificate(before))).filter(needsPublicCertificate)
      : [];
  const l4PortsChange =
    input.targetType === "l4_proxy_host" &&
    (kind !== "update" || (requested.listenAddress !== undefined && requested.listenAddress !== before.listenAddress) ||
      (requested.protocol !== undefined && requested.protocol !== before.protocol));

  const open = input.status === "pending" || input.status === "approved";
  let schedule: ChangeImpact["schedule"];
  if (!open) {
    schedule = {
      state: "done",
      at: input.appliedAt,
      windows: input.window.description,
      description: input.status === "applied" && input.appliedAt ? `Applied ${formatWhen(input.appliedAt)}.` : "This request is closed; nothing more will be applied.",
    };
  } else if (!input.window.restricted) {
    schedule = {
      state: input.status === "approved" ? "now" : "on_approval",
      at: null,
      windows: null,
      description: input.status === "approved" ? "Approved: it can be applied now." : "As soon as it is approved. No change window applies.",
    };
  } else if (input.status === "approved") {
    schedule = input.window.open
      ? { state: "now", at: null, windows: input.window.description, description: "Approved and the change window is open: it can be applied now." }
      : {
          state: "waiting",
          at: input.window.nextOpenAt,
          windows: input.window.description,
          description: input.window.nextOpenAt
            ? `Approved; applied when the change window opens, ${formatWhen(input.window.nextOpenAt)}.`
            : "Approved; the change windows of its policies do not open together in the coming week.",
        };
  } else {
    schedule = input.window.open
      ? { state: "on_approval", at: null, windows: input.window.description, description: "As soon as it is approved, while the change window is open." }
      : {
          state: "next_window",
          at: input.window.nextOpenAt,
          windows: input.window.description,
          description: input.window.nextOpenAt
            ? `At the next change window after approval: ${formatWhen(input.window.nextOpenAt)}.`
            : "At the next change window after approval; the windows of its policies do not open together in the coming week.",
        };
  }

  const label = TARGET_LABELS[input.targetType].toLowerCase();
  const hostText =
    kind === "create"
      ? `${input.targetName}, a new ${label}. No other host changes.`
      : kind === "delete"
        ? `${input.targetName} is deleted. No other host changes.`
        : `${input.targetName}. No other host changes.`;
  const nodesText = input.reach.nodes === 1 ? "this node" : `all ${input.reach.nodes} nodes`;
  const caddyParts = [`Reloads its configuration on ${nodesText}.`];
  if (certificateRequests.length > 0) caddyParts.push(`Requests a certificate for ${certificateRequests.slice(0, 5).join(", ")}${certificateRequests.length > 5 ? " and more" : ""}.`);
  if (l4PortsChange) caddyParts.push("The L4 listening ports change and must be applied, which restarts the Caddy container.");
  if (input.reach.heldBack.length > 0) caddyParts.push(`${input.reach.heldBack.length} instance${input.reach.heldBack.length === 1 ? " gets" : "s get"} it only through promotion.`);

  return {
    hosts: [{ type: input.targetType, id: input.targetId, name: input.targetName, domains: domains.slice(0, 50), change: kind, operations: input.operations }],
    otherHosts: 0,
    caddy: {
      reloads: true,
      nodes: input.reach.nodes,
      instances: input.reach.instances.map((instance) => instance.name),
      heldBack: input.reach.heldBack.map((instance) => instance.name),
      certificateRequests,
      l4PortsChange,
    },
    schedule,
    lines: [
      { key: "hosts", text: hostText },
      { key: "caddy", text: caddyParts.join(" ") },
      { key: "when", text: schedule.description },
    ],
  };
}
