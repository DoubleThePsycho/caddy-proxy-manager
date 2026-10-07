/**
 * Product naming in one place. Wire names (forward-auth headers and cookie,
 * image, container and file names) carry the brand too but are deliberately
 * not derived from this; their pre-rename spellings that existing installs
 * depend on are listed in documentation/upgrading-to-ingressi.md.
 */
export const BRAND_NAME = "Ingressi";

export const BRAND_TAGLINE = "Self-hosted reverse proxy built on Caddy";

/** Shown where users of the old name need to recognise the product. */
export const BRAND_FORMER_NAME = "Caddy Proxy Manager";

/** Where people buy a license or read about the paid editions. */
export const BRAND_WEBSITE = "https://ingres.si";

/**
 * Where the documentation (documentation/ and ee/docs/ in the source
 * repository) is published.
 */
export const DOCUMENTATION_URL = "https://github.com/ingres-si/ingressi/blob/develop";

/** The published page of a documentation file, such as "documentation/mfa.md". */
export function documentationUrl(path: string): string {
  return `${DOCUMENTATION_URL}/${path.replace(/^\/+/, "")}`;
}
