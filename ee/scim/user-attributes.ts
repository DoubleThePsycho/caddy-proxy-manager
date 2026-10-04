// SPDX-License-Identifier: Elastic-2.0
/**
 * The SCIM User attributes this server keeps, how a full resource (POST,
 * PUT) and PATCH operations change them, and the account e-mail address
 * they give.
 *
 * Kept: userName, externalId, name.{givenName,familyName,formatted},
 * displayName, emails, active. Everything else an identity provider sends
 * (title, phoneNumbers, addresses, the enterprise extension, and also
 * password, roles and entitlements) is accepted and ignored: SCIM never sets
 * a password, and roles only come from group-to-role mappings.
 *
 * Identifiers are never derived. userName and the e-mail addresses are kept
 * exactly as sent; the account's e-mail address is the primary address (or
 * the only one, or the "work" one, or the first), stored the way every
 * account e-mail is (trimmed and lowercased, see storedEmail).
 */
import { PORTAL_EMAIL_DOMAIN } from "@/src/lib/sign-in-names";
import { storedEmail } from "@/src/lib/models/user";
import { ApiClientError } from "@/src/lib/api-errors";
import type { ParsedPath } from "./filter";
import { expandPathless, readScimBoolean, readScimString, type PatchOperation } from "./patch";
import { ScimError } from "./protocol";

export type ScimEmail = { value: string; type: string | null; primary: boolean };

export type UserAttributes = {
  userName: string;
  externalId: string | null;
  displayName: string | null;
  givenName: string | null;
  familyName: string | null;
  formattedName: string | null;
  emails: ScimEmail[];
  active: boolean;
};

const MAX_EMAILS = 20;
const MAX_EMAIL_LENGTH = 254;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readEmail(value: unknown): ScimEmail {
  if (typeof value === "string") return { value: checkAddress(value), type: null, primary: false };
  if (!isRecord(value)) throw new ScimError(400, "Each e-mail must be an object with a value", "invalidValue");
  const address = checkAddress(value.value);
  const type = readScimString(value.type, "emails.type", { max: 64 });
  const primary = value.primary === undefined || value.primary === null ? false : readScimBoolean(value.primary, "emails.primary");
  return { value: address, type, primary };
}

/** An address as sent; refused when it cannot be an account's e-mail address. */
function checkAddress(raw: unknown): string {
  const value = readScimString(raw, "emails.value", { max: MAX_EMAIL_LENGTH, required: true })!;
  const trimmed = value.trim();
  const at = trimmed.lastIndexOf("@");
  if (at <= 0 || at === trimmed.length - 1 || /\s/.test(trimmed)) {
    throw new ScimError(400, `"${trimmed.slice(0, 100)}" is not an e-mail address`, "invalidValue");
  }
  // A @localhost address is a forward-auth portal name (see sign-in-names.ts).
  if (trimmed.toLowerCase().endsWith(PORTAL_EMAIL_DOMAIN)) {
    throw new ScimError(400, `E-mail addresses ending in ${PORTAL_EMAIL_DOMAIN} are not allowed`, "invalidValue");
  }
  return value;
}

function readEmails(value: unknown): ScimEmail[] {
  if (value === null || value === undefined) return [];
  const list = Array.isArray(value) ? value : [value];
  if (list.length > MAX_EMAILS) throw new ScimError(400, `At most ${MAX_EMAILS} e-mail addresses`, "invalidValue");
  return list.map(readEmail);
}

/** Only one address may be primary (RFC 7643 section 2.4); a new primary one demotes the others. */
function withSinglePrimary(emails: ScimEmail[], preferred: ScimEmail | null = null): ScimEmail[] {
  const primary = preferred?.primary ? preferred : emails.find((email) => email.primary) ?? null;
  return emails.map((email) => ({ ...email, primary: email === primary }));
}

/** Attributes of a full User resource (POST, PUT). `current` supplies `active` when it is left out. */
export function readUserResource(body: unknown, current: UserAttributes | null): UserAttributes {
  if (!isRecord(body)) throw new ScimError(400, "The request body must be a JSON object", "invalidSyntax");
  const name = body.name === undefined || body.name === null ? {} : body.name;
  if (!isRecord(name)) throw new ScimError(400, "name must be an object", "invalidValue");
  const emails = readEmails(body.emails);
  if (emails.filter((email) => email.primary).length > 1) {
    throw new ScimError(400, "Only one e-mail address can be primary", "invalidValue");
  }
  return {
    userName: readScimString(body.userName, "userName", { required: true })!,
    externalId: readScimString(body.externalId, "externalId"),
    displayName: readScimString(body.displayName, "displayName"),
    givenName: readScimString(name.givenName, "name.givenName"),
    familyName: readScimString(name.familyName, "name.familyName"),
    formattedName: readScimString(name.formatted, "name.formatted"),
    emails,
    active: body.active === undefined || body.active === null ? current?.active ?? true : readScimBoolean(body.active, "active"),
  };
}

function matchesEmailFilter(email: ScimEmail, filter: NonNullable<ParsedPath["filter"]>): boolean {
  const value = filter.value;
  switch (filter.attribute) {
    case "type":
      return typeof value === "string" && (email.type ?? "").toLowerCase() === value.toLowerCase();
    case "value":
      return typeof value === "string" && email.value.toLowerCase() === value.toLowerCase();
    case "primary":
      return email.primary === (value === true || (typeof value === "string" && value.toLowerCase() === "true"));
    default:
      throw new ScimError(400, "E-mail filters can use type, value or primary", "invalidPath");
  }
}

function patchEmails(attributes: UserAttributes, operation: PatchOperation & { path: ParsedPath }): void {
  const { op, path, value } = operation;
  if (path.filter) {
    const matches = attributes.emails.filter((email) => matchesEmailFilter(email, path.filter!));
    if (op === "remove") {
      if (path.subAttribute === null || path.subAttribute === "value") {
        attributes.emails = attributes.emails.filter((email) => !matches.includes(email));
      } else if (path.subAttribute === "type") {
        for (const email of matches) email.type = null;
      } else if (path.subAttribute === "primary") {
        for (const email of matches) email.primary = false;
      }
      return;
    }
    // add/replace on emails[filter] or emails[filter].sub
    let targets = matches;
    if (targets.length === 0) {
      // RFC 7644 3.5.2.1: add a value that the filter would match.
      const created: ScimEmail = {
        value: "",
        type: path.filter.attribute === "type" && typeof path.filter.value === "string" ? path.filter.value : null,
        primary: path.filter.attribute === "primary" ? path.filter.value === true : !attributes.emails.some((e) => e.primary),
      };
      if (path.filter.attribute === "value" && typeof path.filter.value === "string") created.value = path.filter.value;
      attributes.emails.push(created);
      targets = [created];
    }
    for (const email of targets) {
      if (path.subAttribute === null) {
        const next = readEmail(isRecord(value) ? { ...email, ...value } : value);
        Object.assign(email, next);
      } else if (path.subAttribute === "value") {
        email.value = checkAddress(value);
      } else if (path.subAttribute === "type") {
        email.type = readScimString(value, "emails.type", { max: 64 });
      } else if (path.subAttribute === "primary") {
        email.primary = readScimBoolean(value, "emails.primary");
      }
    }
    if (targets.some((email) => !email.value)) {
      throw new ScimError(400, "emails.value is required", "invalidValue");
    }
    attributes.emails = withSinglePrimary(attributes.emails, targets.find((email) => email.primary) ?? null);
    return;
  }
  if (path.subAttribute !== null) {
    // emails.value without a filter: the primary (or only) address.
    if (op === "remove") return;
    const target = attributes.emails.find((email) => email.primary) ?? (attributes.emails.length === 1 ? attributes.emails[0] : null);
    if (path.subAttribute === "value") {
      if (target) target.value = checkAddress(value);
      else attributes.emails.push({ value: checkAddress(value), type: null, primary: attributes.emails.length === 0 });
    }
    return;
  }
  if (op === "remove") {
    if (value === undefined || value === null) {
      attributes.emails = [];
      return;
    }
    const removed = readEmails(value).map((email) => email.value.toLowerCase());
    attributes.emails = attributes.emails.filter((email) => !removed.includes(email.value.toLowerCase()));
    return;
  }
  const incoming = readEmails(value);
  if (op === "replace") {
    if (incoming.filter((email) => email.primary).length > 1) {
      throw new ScimError(400, "Only one e-mail address can be primary", "invalidValue");
    }
    attributes.emails = incoming;
    return;
  }
  // add: merge by address.
  let preferred: ScimEmail | null = null;
  for (const email of incoming) {
    const existing = attributes.emails.find((item) => item.value.toLowerCase() === email.value.toLowerCase());
    if (existing) {
      existing.type = email.type ?? existing.type;
      existing.primary = email.primary || existing.primary;
      if (email.primary) preferred = existing;
    } else {
      attributes.emails.push(email);
      if (email.primary) preferred = email;
    }
  }
  attributes.emails = withSinglePrimary(attributes.emails, preferred);
}

function patchName(attributes: UserAttributes, operation: PatchOperation & { path: ParsedPath }): void {
  const { op, path, value } = operation;
  const set = (sub: string, input: unknown) => {
    if (sub === "givenname") attributes.givenName = readScimString(input, "name.givenName");
    else if (sub === "familyname") attributes.familyName = readScimString(input, "name.familyName");
    else if (sub === "formatted") attributes.formattedName = readScimString(input, "name.formatted");
  };
  if (path.subAttribute !== null) {
    set(path.subAttribute, op === "remove" ? null : value);
    return;
  }
  if (op === "remove") {
    attributes.givenName = attributes.familyName = attributes.formattedName = null;
    return;
  }
  if (!isRecord(value)) throw new ScimError(400, "name must be an object", "invalidValue");
  if (op === "replace") attributes.givenName = attributes.familyName = attributes.formattedName = null;
  for (const [key, item] of Object.entries(value)) set(key.toLowerCase(), item);
}

/** Applies PATCH operations to a copy of `current`. */
export function applyUserPatch(current: UserAttributes, operations: readonly PatchOperation[]): UserAttributes {
  const attributes: UserAttributes = { ...current, emails: current.emails.map((email) => ({ ...email })) };
  for (const operation of operations.flatMap(expandPathless)) {
    const path = operation.path!;
    const { op, value } = operation;
    switch (path.attribute) {
      case "username":
        if (op === "remove") throw new ScimError(400, "userName cannot be removed", "mutability");
        attributes.userName = readScimString(value, "userName", { required: true })!;
        break;
      case "externalid":
        attributes.externalId = op === "remove" ? null : readScimString(value, "externalId");
        break;
      case "displayname":
        attributes.displayName = op === "remove" ? null : readScimString(value, "displayName");
        break;
      case "active":
        if (op === "remove") throw new ScimError(400, "active cannot be removed", "mutability");
        attributes.active = readScimBoolean(value, "active");
        break;
      case "name":
        patchName(attributes, { ...operation, path });
        break;
      case "emails":
        patchEmails(attributes, { ...operation, path });
        break;
      default:
        // id, meta, schemas, groups (read-only), password, roles,
        // entitlements and attributes this server does not keep.
        break;
    }
  }
  return attributes;
}

/** The address the account gets, as sent: primary, else the only one, else "work", else the first. */
export function accountEmailOf(attributes: UserAttributes): string {
  const emails = attributes.emails;
  if (emails.length === 0) {
    throw new ScimError(400, "emails is required: the account needs an e-mail address", "invalidValue");
  }
  if (emails.filter((email) => email.primary).length > 1) {
    throw new ScimError(400, "Only one e-mail address can be primary", "invalidValue");
  }
  const chosen =
    emails.find((email) => email.primary) ??
    emails.find((email) => (email.type ?? "").toLowerCase() === "work") ??
    emails[0];
  try {
    return storedEmail(chosen.value);
  } catch (error) {
    if (error instanceof ApiClientError) throw new ScimError(400, error.message, "invalidValue");
    throw error;
  }
}

/** The account's display name: displayName, else name.formatted, else given and family name. */
export function accountNameOf(attributes: UserAttributes): string | null {
  const parts = [attributes.givenName, attributes.familyName].filter((part): part is string => !!part && !!part.trim());
  return attributes.displayName?.trim() || attributes.formattedName?.trim() || (parts.length ? parts.join(" ") : null);
}

export function parseStoredEmails(raw: string | null | undefined): ScimEmail[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value
      .filter((item) => isRecord(item) && typeof item.value === "string")
      .map((item) => ({
        value: item.value as string,
        type: typeof item.type === "string" ? item.type : null,
        primary: item.primary === true,
      }));
  } catch {
    return [];
  }
}
