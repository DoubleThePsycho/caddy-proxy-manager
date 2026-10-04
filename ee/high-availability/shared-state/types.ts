// SPDX-License-Identifier: Elastic-2.0
/**
 * High availability (feature "high_availability", Enterprise), phase 3:
 * shared request-path state. Forward-auth sessions, exchange codes and
 * redirect intents, and API monetization balances and usage counters, kept
 * in Redis or Valkey instead of each web node's SQLite and memory, so every
 * web node serves forward auth and monetized hosts the same way.
 *
 * Shared types and constants. Safe to import from client components.
 */

/** The settings key of this instance's switch. Not synced: see service.ts. */
export const SHARED_STATE_SETTING_KEY = "ha_shared_state";

export const DEFAULT_SHARED_STATE_PREFIX = "ingressi";

export const SHARED_STATE_LIMITS = {
  keyPrefix: 100,
} as const;

/** The stored setting. The connection is the certificate storage's Redis settings. */
export type StoredSharedState = {
  enabled: boolean;
  /** Every key starts with `<keyPrefix>:<generation>:`. */
  keyPrefix: string;
  /**
   * Changes each time shared state is turned on, so state left in Redis by an
   * earlier period is never read again (it expires on its own).
   */
  generation: string;
};

export type SharedStateBackend = "local" | "redis";

/** Where the connection settings come from. */
export type SharedStateConnectionSource = "certificate_storage";

export type SharedStateDrainStatus = {
  /** When the leader last wrote shared monetization usage and credits to its database. */
  at: string | null;
  /** Consumers whose usage or credits were written in that drain. */
  consumers: number;
  /** Credit entries (top-ups, adjustments) taken from the credit streams in that drain. */
  credits: number;
  /** A fixed message when the last drain failed. */
  error: string | null;
};

export type SharedStateKeyCounts = {
  forwardAuthSessions: number;
  monetizationConsumers: number;
  /** Credit entries not yet written to the ledger. */
  pendingCredits: number;
};

export type SharedStateView = {
  /** Shared state is switched on for this instance. */
  enabled: boolean;
  /** What request paths use right now: "redis" only when enabled and the connection settings are usable. */
  backend: SharedStateBackend;
  keyPrefix: string;
  /** The full prefix in use, `<keyPrefix>:<generation>:`, or null when off. */
  namespace: string | null;
  connection: {
    source: SharedStateConnectionSource;
    /** The certificate storage has Redis or Valkey settings to connect with. */
    configured: boolean;
    mode: string | null;
    addresses: string[];
    tls: boolean;
  };
  updatedAt: string | null;
  /** The license lets this instance turn shared state on or change it (turning it off never needs it). */
  configurable: boolean;
  /** False on a sync slave: slaves keep their request-path state local. */
  editable: boolean;
  /** Set when shared state is on but cannot be used (no Redis settings, a secret that cannot be read). */
  error: string | null;
};

export type SharedStateStatus = {
  backend: SharedStateBackend;
  /** The server answered PING. Null when shared state is off. */
  reachable: boolean | null;
  /** A fixed message when it did not. */
  error: string | null;
  keys: SharedStateKeyCounts | null;
  drain: SharedStateDrainStatus | null;
  /** This node runs the drain (it is the leader). */
  leader: boolean;
};

export type SharedStateActionResult = { ok: true; view: SharedStateView } | { ok: false; error: string };
export type SharedStateStatusActionResult = { ok: true; status: SharedStateStatus } | { ok: false; error: string };
