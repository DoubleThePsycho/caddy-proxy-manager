// SPDX-License-Identifier: Elastic-2.0
/**
 * Checking a username and password against a directory, reading the entry's
 * attributes and its groups. Nothing here touches the database.
 *
 * The order is fixed:
 *  1. Refuse an empty or blank password (and username) before any network
 *     traffic: a simple bind with an empty password is an "unauthenticated"
 *     bind that many servers accept as a success.
 *  2. Bind as the service account and search for the user with the
 *     administrator's filter, the typed username escaped per RFC 4515.
 *     Exactly one entry must match.
 *  3. Bind as that entry's DN, as the directory returned it, with the typed
 *     password, on a second connection. An unknown user, several matches and
 *     a wrong password all end in a failed bind on that connection (against
 *     a DN that cannot exist when there is no single entry), so they look and
 *     take alike.
 *  4. Only then read the entry (stable unique id, username, e-mail, display
 *     name) and look up its groups with the service account.
 *
 * Failures before step 3 do not depend on the password or on whether the
 * user exists, so callers may report them as "the directory is not
 * available"; every failure from step 3 on must be reported like a wrong
 * password.
 */
import { randomUUID } from "node:crypto";
import { EqualityFilter, type Entry } from "ldapts";
import { LIMITS, MATCHING_RULE_IN_CHAIN } from "./constants";
import { DirectoryConnection, describeDirectoryError, type TransportConfig } from "./connection";
import { escapeFilterValue, fillFilter } from "./filter";
import type { DirectoryConfig, DirectoryUser } from "./types";

export type AuthFailureReason =
  /** Empty, blank or oversized input; nothing was sent to the directory. */
  | "invalid_input"
  /** The directory could not be reached or searched (independent of the password). */
  | "directory_unavailable"
  | "unknown_user"
  | "multiple_entries"
  | "wrong_password"
  /** The password was right but the entry lacks a usable unique id or username. */
  | "incomplete_entry"
  /** The password was right but the groups could not be read (or were too many). */
  | "groups_unavailable";

export type AuthenticationResult =
  | { ok: true; user: DirectoryUser }
  | { ok: false; reason: AuthFailureReason; detail: string };

/** Reasons a sign-in reports exactly like a wrong password. */
export const CREDENTIAL_FAILURES: ReadonlySet<AuthFailureReason> = new Set([
  "invalid_input",
  "unknown_user",
  "multiple_entries",
  "wrong_password",
  "incomplete_entry",
  "groups_unavailable",
]);

/** Why typed credentials are refused before anything is sent, or null. */
export function signInInputProblem(username: unknown, password: unknown): string | null {
  if (typeof username !== "string" || typeof password !== "string") return "username and password are required";
  // An empty password would be an unauthenticated bind, which servers accept.
  if (!username.trim() || !password.trim()) return "username and password must not be empty";
  if (username.length > LIMITS.username || password.length > LIMITS.password) return "username or password too long";
  if (/\p{Cc}/u.test(username)) return "username contains control characters";
  if (password.includes("\0")) return "password contains NUL";
  return null;
}

// ── Reading entries ──────────────────────────────────────────────────

/** Names servers commonly use for stable ids, in their canonical case (ldapts matches buffer attributes by exact name). */
const KNOWN_ID_ATTRIBUTES = ["objectGUID", "entryUUID", "nsUniqueId", "ipaUniqueID", "GUID", "orclGUID"];

function bufferAttributeNames(attribute: string): string[] {
  const lower = attribute.toLowerCase();
  return [...new Set([attribute, lower, ...KNOWN_ID_ATTRIBUTES.filter((name) => name.toLowerCase() === lower)])];
}

/** The values of `attribute` (matched without regard to case; ranged or tagged variants are not read). */
function rawValues(entry: Entry, attribute: string): Array<string | Buffer> {
  const lower = attribute.toLowerCase();
  const key = Object.keys(entry).find((name) => name !== "dn" && name.toLowerCase() === lower);
  if (!key) return [];
  const value = entry[key];
  return (Array.isArray(value) ? value : [value]) as Array<string | Buffer>;
}

function textValue(value: string | Buffer): string {
  return Buffer.isBuffer(value) ? value.toString("utf8") : value;
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

/** Active Directory's GUID string form of an objectGUID (the first three groups little-endian). */
export function formatObjectGuid(bytes: Uint8Array): string {
  const b = Buffer.from(bytes);
  const le = (start: number, length: number) => hex(Uint8Array.from(b.subarray(start, start + length)).reverse());
  return `${le(0, 4)}-${le(4, 2)}-${le(6, 2)}-${hex(b.subarray(8, 10))}-${hex(b.subarray(10, 16))}`;
}

/** The bytes of a GUID string from formatObjectGuid, or null. */
export function parseObjectGuid(guid: string): Buffer | null {
  const match = /^([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})$/.exec(guid);
  if (!match) return null;
  const le = (text: string) => Buffer.from(text, "hex").reverse();
  return Buffer.concat([le(match[1]), le(match[2]), le(match[3]), Buffer.from(match[4], "hex"), Buffer.from(match[5], "hex")]);
}

const HEX_ID_PREFIX = "hex:";

/**
 * The stable unique id of an entry as stored in accounts.accountId: an
 * objectGUID in its GUID form, a text id (entryUUID and the like) as
 * returned, and any other binary value as "hex:" and its bytes. Null unless
 * the entry has exactly one usable value.
 */
export function readUniqueId(entry: Entry, attribute: string): string | null {
  const values = rawValues(entry, attribute);
  if (values.length !== 1) return null;
  const value = values[0];
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  if (bytes.length === 0) return null;
  if (attribute.toLowerCase() === "objectguid") return bytes.length === 16 ? formatObjectGuid(bytes) : null;
  let text: string | null;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    text = null;
  }
  const id = text !== null && !/\p{Cc}/u.test(text) && text.trim() === text ? text : `${HEX_ID_PREFIX}${hex(bytes)}`;
  return id.length <= LIMITS.uniqueId ? id : null;
}

/**
 * The filter that finds the entry with unique id `accountId` (the inverse of
 * readUniqueId), or null. Built as a filter object rather than a string: a
 * binary value (objectGUID) does not survive ldapts' parsing of \XX escapes.
 */
export function uniqueIdFilter(attribute: string, accountId: string): EqualityFilter | null {
  if (attribute.toLowerCase() === "objectguid") {
    const bytes = parseObjectGuid(accountId);
    return bytes ? new EqualityFilter({ attribute, value: bytes }) : null;
  }
  if (accountId.startsWith(HEX_ID_PREFIX)) {
    const raw = accountId.slice(HEX_ID_PREFIX.length);
    return /^(?:[0-9a-f]{2})+$/.test(raw) ? new EqualityFilter({ attribute, value: Buffer.from(raw, "hex") }) : null;
  }
  return accountId ? new EqualityFilter({ attribute, value: accountId }) : null;
}

/** A single text value within `max` characters and without control characters, or null. */
function singleText(values: Array<string | Buffer>, max: number): string | null {
  const first = values[0];
  if (first === undefined) return null;
  const text = textValue(first);
  if (!text || text.length > max || /\p{Cc}/u.test(text)) return null;
  return text;
}

/**
 * The username attribute as returned. When the entry has several values
 * (OpenLDAP allows several uid values), the one the person typed is used if
 * it is among them, otherwise the first.
 */
function readUsername(values: Array<string | Buffer>, typed: string): string | null {
  const texts = values.map(textValue).filter((text) => text && text.length <= LIMITS.value && !/\p{Cc}/u.test(text));
  if (texts.length === 0) return null;
  return texts.find((text) => text === typed) ??
    texts.find((text) => text.toLowerCase() === typed.toLowerCase()) ??
    texts[0];
}

// ── Groups ───────────────────────────────────────────────────────────

class TooManyGroupsError extends Error {
  constructor() {
    super(`more than ${LIMITS.groups} groups`);
  }
}

function timeLimitSeconds(config: TransportConfig): number {
  return Math.max(1, Math.ceil(config.operationTimeoutMs / 1000));
}

/** Group DNs from a paged search, failing closed beyond LIMITS.groups or on a server-side size limit. */
async function searchGroupDns(connection: DirectoryConnection, config: DirectoryConfig, base: string, filter: string): Promise<string[]> {
  const dns: string[] = [];
  for await (const page of connection.searchPaginated(base, {
    scope: "sub",
    filter,
    attributes: ["1.1"],
    derefAliases: "never",
    timeLimit: timeLimitSeconds(config),
    paged: { pageSize: 200 },
  })) {
    for (const entry of page.searchEntries) {
      if (typeof entry.dn === "string" && entry.dn) dns.push(entry.dn);
      if (dns.length > LIMITS.groups) throw new TooManyGroupsError();
    }
  }
  return dns;
}

async function lookupGroups(
  connection: DirectoryConnection,
  config: DirectoryConfig,
  entry: Entry,
  username: string
): Promise<string[] | null> {
  if (config.groupMode === "none") return null;
  if (config.groupMode === "member_of" && !config.nestedGroups) {
    const values = rawValues(entry, config.groupMembershipAttribute);
    if (values.length > LIMITS.groups) throw new TooManyGroupsError();
    return values.map(textValue).filter((dn) => dn.length > 0 && dn.length <= LIMITS.dn);
  }
  if (config.groupMode === "member_of") {
    // Active Directory: every group the user is in, directly or through other groups.
    const filter = `(member:${MATCHING_RULE_IN_CHAIN}:=${escapeFilterValue(entry.dn)})`;
    return searchGroupDns(connection, config, config.groupSearchBase!, filter);
  }
  const filter = fillFilter(config.groupSearchFilter!, { dn: entry.dn, username });
  return searchGroupDns(connection, config, config.groupSearchBase!, filter);
}

// ── Authentication ───────────────────────────────────────────────────

async function closeAll(...connections: Array<DirectoryConnection | null>): Promise<void> {
  await Promise.all(connections.filter((connection) => connection !== null).map((connection) => connection.close()));
}

function attributesToRead(config: DirectoryConfig): string[] {
  const attributes = [config.usernameAttribute, config.emailAttribute, config.displayNameAttribute, config.uniqueIdAttribute];
  if (config.groupMode === "member_of" && !config.nestedGroups) attributes.push(config.groupMembershipAttribute);
  return [...new Set(attributes)];
}

/** Opens a connection and binds as the service account. */
async function serviceConnection(config: DirectoryConfig): Promise<DirectoryConnection> {
  const connection = await DirectoryConnection.open(config);
  try {
    await connection.bind(config.bindDn, config.bindPassword);
  } catch (error) {
    await connection.close();
    throw error;
  }
  return connection;
}

export type AuthenticateOptions = {
  /** Read the user's groups (default true). */
  groups?: boolean;
};

export async function authenticateDirectoryUser(
  config: DirectoryConfig,
  typedUsername: string,
  password: string,
  options: AuthenticateOptions = {}
): Promise<AuthenticationResult> {
  const problem = signInInputProblem(typedUsername, password);
  if (problem) return { ok: false, reason: "invalid_input", detail: problem };
  const username = typedUsername.trim();

  let service: DirectoryConnection | null = null;
  let userConnection: DirectoryConnection | null = null;
  try {
    let entries: Entry[];
    try {
      service = await serviceConnection(config);
      const result = await service.search(config.userSearchBase, {
        scope: "sub",
        filter: fillFilter(config.userSearchFilter, { username }),
        attributes: attributesToRead(config),
        explicitBufferAttributes: bufferAttributeNames(config.uniqueIdAttribute),
        // Two are enough to know the match is not unique.
        sizeLimit: 2,
        timeLimit: timeLimitSeconds(config),
        derefAliases: "never",
      });
      entries = result.searchEntries.filter((entry) => typeof entry.dn === "string" && entry.dn.trim() !== "");
      userConnection = await DirectoryConnection.open(config);
    } catch (error) {
      return { ok: false, reason: "directory_unavailable", detail: describeDirectoryError(error) };
    }

    const entry = entries.length === 1 ? entries[0] : null;
    try {
      // With no single entry, bind to a DN that cannot exist, so the reply
      // and its timing match a wrong password.
      await userConnection.bind(entry ? entry.dn : `cn=${randomUUID()},${config.userSearchBase}`, password);
    } catch (error) {
      if (!entry) {
        return entries.length === 0
          ? { ok: false, reason: "unknown_user", detail: "no entry matches the username" }
          : { ok: false, reason: "multiple_entries", detail: "more than one entry matches the username" };
      }
      return { ok: false, reason: "wrong_password", detail: describeDirectoryError(error) };
    }
    if (!entry) {
      // A server that accepts a bind to a DN that does not exist is misconfigured; never sign in on it.
      return { ok: false, reason: entries.length === 0 ? "unknown_user" : "multiple_entries", detail: "no single entry matches the username" };
    }

    const uniqueId = readUniqueId(entry, config.uniqueIdAttribute);
    if (!uniqueId) {
      return { ok: false, reason: "incomplete_entry", detail: `the entry has no single usable ${config.uniqueIdAttribute} value` };
    }
    const directoryUsername = readUsername(rawValues(entry, config.usernameAttribute), username);
    if (!directoryUsername) {
      return { ok: false, reason: "incomplete_entry", detail: `the entry has no usable ${config.usernameAttribute} value` };
    }
    const emailValues = rawValues(entry, config.emailAttribute);
    const email = emailValues.length > 0 ? singleText(emailValues, LIMITS.email) : null;
    if (emailValues.length > 0 && email === null) {
      return { ok: false, reason: "incomplete_entry", detail: `the ${config.emailAttribute} value is not usable` };
    }
    const displayName = singleText(rawValues(entry, config.displayNameAttribute), LIMITS.displayName);

    let groups: string[] | null = null;
    if (options.groups !== false) {
      try {
        groups = await lookupGroups(service!, config, entry, directoryUsername);
      } catch (error) {
        const detail = error instanceof TooManyGroupsError ? error.message : describeDirectoryError(error);
        return { ok: false, reason: "groups_unavailable", detail: `group lookup failed: ${detail}` };
      }
    }

    return {
      ok: true,
      user: { dn: entry.dn, uniqueId, username: directoryUsername, email, displayName, groups },
    };
  } finally {
    await closeAll(service, userConnection);
  }
}

/**
 * Checks `password` for the entry linked as `accountId` (its stable unique
 * id): finds the entry with the service account, then signs in with its
 * username exactly as sign-in does, so the user filter still applies (an
 * entry it no longer matches, such as a disabled Active Directory account,
 * is refused). Used to confirm the password where a local one would be asked.
 */
export async function verifyLinkedEntryPassword(
  config: DirectoryConfig,
  accountId: string,
  password: string
): Promise<boolean> {
  if (typeof password !== "string" || !password.trim()) return false;
  const filter = uniqueIdFilter(config.uniqueIdAttribute, accountId);
  if (!filter) return false;
  let usernames: string[];
  let service: DirectoryConnection | null = null;
  try {
    service = await serviceConnection(config);
    const result = await service.search(config.userSearchBase, {
      scope: "sub",
      filter,
      attributes: [config.usernameAttribute],
      sizeLimit: 2,
      timeLimit: timeLimitSeconds(config),
      derefAliases: "never",
    });
    if (result.searchEntries.length !== 1) return false;
    usernames = rawValues(result.searchEntries[0], config.usernameAttribute).map(textValue).filter(Boolean);
  } catch {
    return false;
  } finally {
    await closeAll(service);
  }
  for (const username of usernames.slice(0, 5)) {
    const outcome = await authenticateDirectoryUser(config, username, password, { groups: false });
    if (outcome.ok) return outcome.user.uniqueId === accountId;
    if (outcome.reason !== "unknown_user" && outcome.reason !== "multiple_entries") return false;
  }
  return false;
}

export type ConnectionTestResult = {
  ok: boolean;
  /** What was checked, in order, and how it went. */
  steps: Array<{ step: "connect" | "bind" | "search_base"; ok: boolean; detail: string }>;
};

/** Connects (with TLS as configured), binds as the service account and reads the user search base. */
export async function testDirectoryConnection(config: DirectoryConfig): Promise<ConnectionTestResult> {
  const steps: ConnectionTestResult["steps"] = [];
  let connection: DirectoryConnection | null = null;
  try {
    try {
      connection = await DirectoryConnection.open(config);
      steps.push({
        step: "connect",
        ok: true,
        detail: config.url.startsWith("ldaps:") ? "connected with TLS" : config.startTls ? "connected and upgraded with StartTLS" : "connected without TLS",
      });
    } catch (error) {
      steps.push({ step: "connect", ok: false, detail: describeDirectoryError(error) });
      return { ok: false, steps };
    }
    try {
      await connection.bind(config.bindDn, config.bindPassword);
      steps.push({ step: "bind", ok: true, detail: "service account accepted" });
    } catch (error) {
      steps.push({ step: "bind", ok: false, detail: describeDirectoryError(error) });
      return { ok: false, steps };
    }
    try {
      await connection.search(config.userSearchBase, {
        scope: "base",
        attributes: ["1.1"],
        sizeLimit: 1,
        timeLimit: timeLimitSeconds(config),
        derefAliases: "never",
      });
      steps.push({ step: "search_base", ok: true, detail: "user search base found" });
    } catch (error) {
      steps.push({ step: "search_base", ok: false, detail: describeDirectoryError(error) });
      return { ok: false, steps };
    }
    return { ok: true, steps };
  } finally {
    await closeAll(connection);
  }
}
