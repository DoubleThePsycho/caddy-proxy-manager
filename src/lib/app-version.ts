// Application version, inlined at build time by next.config.mjs.
// next.config.mjs resolves it from the APP_VERSION build arg (set by CI to the
// git tag for release builds, or the git commit SHA for non-release builds) and
// falls back to the git commit or package.json version when unset.
export const APP_VERSION: string =
  process.env.NEXT_PUBLIC_APP_VERSION?.trim() || "unknown";

/** A release: semver such as 2.0.0 or 2.1.0-rc.1, with or without a leading "v". */
const RELEASE_VERSION = /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/;
/** A commit build: the commit's hash, abbreviated or not. */
const COMMIT_VERSION = /^[0-9a-f]{7,40}$/i;

export function isReleaseVersion(version: string): boolean {
  return RELEASE_VERSION.test(version.trim());
}

/**
 * A version where space is tight: "v2.0.0" for a release, the short hash
 * ("18b823e") for a commit build, anything else as it is.
 */
export function formatVersion(version: string): string {
  const value = version.trim();
  if (isReleaseVersion(value)) return `v${value.replace(/^v/, "")}`;
  if (COMMIT_VERSION.test(value)) return value.slice(0, 7).toLowerCase();
  return value;
}

/**
 * The version after the product name: "v2.0.0" for a release ("Ingressi
 * v2.0.0"), "build 18b823e" for a commit build ("Ingressi build 18b823e").
 */
export function formatAppVersion(version: string = APP_VERSION): string {
  const value = version.trim();
  if (!value || value === "unknown") return "version unknown";
  if (!isReleaseVersion(value) && COMMIT_VERSION.test(value)) return `build ${formatVersion(value)}`;
  return formatVersion(value);
}
