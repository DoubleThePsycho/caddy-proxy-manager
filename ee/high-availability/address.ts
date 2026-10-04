// SPDX-License-Identifier: Elastic-2.0
/**
 * host:port parsing shared by the certificate storage settings (settings.ts)
 * and the dashboard cluster's environment configuration (cluster/config.ts).
 * No other imports, so the cluster supervisor bundle stays small.
 */
import { isIP } from "node:net";

/** Longest host name accepted. */
export const MAX_HOST_LENGTH = 253;

const HOST_LABEL = "[A-Za-z0-9](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9])?";
const HOST_NAME = new RegExp(`^${HOST_LABEL}(?:\\.${HOST_LABEL})*$`);

/** An address that is not host:port; the message is safe to show. */
export class AddressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AddressError";
  }
}

/** A "host:port" (IPv6 in brackets), normalized to lower case. Throws AddressError. */
export function parseHostPort(value: unknown, field = "address"): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new AddressError(`${field} must be host:port`);
  const text = value.trim();
  if (text.length > MAX_HOST_LENGTH + 8) throw new AddressError(`${field} is too long`);
  let host: string;
  let portText: string;
  if (text.startsWith("[")) {
    const end = text.indexOf("]");
    if (end < 0 || text[end + 1] !== ":") throw new AddressError(`${field} must be host:port, with an IPv6 address in brackets`);
    host = text.slice(1, end);
    portText = text.slice(end + 2);
    if (isIP(host) !== 6) throw new AddressError(`${field} has an invalid IPv6 address`);
  } else {
    const colon = text.lastIndexOf(":");
    if (colon <= 0) throw new AddressError(`${field} must be host:port`);
    host = text.slice(0, colon);
    portText = text.slice(colon + 1);
    if (host.includes(":")) throw new AddressError(`${field}: put an IPv6 address in brackets, e.g. [2001:db8::1]:6379`);
    if (isIP(host) !== 4 && !(host.length <= MAX_HOST_LENGTH && HOST_NAME.test(host))) {
      throw new AddressError(`${field} has an invalid host name`);
    }
  }
  if (!/^\d{1,5}$/.test(portText)) throw new AddressError(`${field} must end with a port number`);
  const port = Number(portText);
  if (port < 1 || port > 65535) throw new AddressError(`${field} must have a port from 1 to 65535`);
  const normalized = host.toLowerCase();
  return isIP(normalized) === 6 ? `[${normalized}]:${port}` : `${normalized}:${port}`;
}
