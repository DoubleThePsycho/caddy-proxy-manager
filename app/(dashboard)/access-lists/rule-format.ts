/** What the access list pages show for a rule's kind, and the dates of rules and users. */
import { CONTINENTS, type AccessListRuleKind } from "@/src/lib/access-list-rules";

export const KIND_OPTIONS: Record<AccessListRuleKind, { label: string; placeholder: string; hint: string }> = {
  ip: {
    label: "Address or network",
    placeholder: "203.0.113.0/24, 2001:db8::/48",
    hint: "IPv4 or IPv6 addresses and CIDR ranges, separated by commas. private_ranges covers the private networks.",
  },
  country: { label: "Country", placeholder: "IT, FR, DE", hint: "Two-letter country codes, separated by commas." },
  continent: {
    label: "Continent",
    placeholder: "EU",
    hint: `Continent codes: ${CONTINENTS.map((continent) => `${continent.code} ${continent.name}`).join(", ")}.`,
  },
  asn: { label: "AS number", placeholder: "AS64500", hint: "AS numbers, with or without the AS prefix." },
};

export function fmtDay(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

export function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

/** ISO 8601 to the value of a datetime-local input, in local time. */
export function toLocalInput(iso: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function fromLocalInput(value: string): string {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}
