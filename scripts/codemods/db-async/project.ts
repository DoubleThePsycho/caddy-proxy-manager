/**
 * The TypeScript program the db-async codemod works on, and how it sorts the
 * repository's files: which scope a file is in (production code or tests),
 * which review area it belongs to (areaOf), and which files the codemod
 * must never change.
 */
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export type Scope = "production" | "tests" | "other";

/** Files the codemod reads (for their call sites) but never changes. */
const EXCLUDED: readonly RegExp[] = [
  // The database layer itself, which stays synchronous where it must.
  /^src\/lib\/db\.ts$/,
  /^src\/lib\/db\//,
  // The high-availability cluster supervisor's own local SQLite database.
  /^ee\/high-availability\/cluster\//,
  // ClickHouse (analytics); src/lib/analytics/** only reaches SQLite through
  // functions defined elsewhere, and its ClickHouse queries are never Drizzle
  // SQLite builders, so the type-based rules never select them.
  /^src\/lib\/clickhouse\//,
];

/** Repository-relative path with forward slashes. */
export function relPath(fileName: string, root: string = REPO_ROOT): string {
  return relative(root, fileName).split(sep).join("/");
}

export function scopeOf(rel: string): Scope {
  if (rel.startsWith("tests/")) return "tests";
  if (rel === "proxy.ts" || rel.startsWith("src/") || rel.startsWith("app/") || rel.startsWith("ee/")) return "production";
  return "other";
}

export function isExcluded(rel: string): boolean {
  return EXCLUDED.some((pattern) => pattern.test(rel));
}

/** Whether a call site or function in this file is part of the analysis at all. */
export function isAnalyzed(rel: string): boolean {
  return scopeOf(rel) !== "other" && !rel.includes("node_modules/");
}

const R2_FILES = /^src\/lib\/(auth-server|auth|mfa|mfa-auth|passkeys|passkey-auth|sign-in-[^/]*|login-[^/]*|init-db|access-scope|api-auth|identity-health|users-overview)\.tsx?$/;
const R3_FILES =
  /^src\/lib\/(config-content|config-replace|config-transfer|instance-sync[^/]*|settings|audit|audit-chain|forward-auth-state|caddy[^/]*|change-batch|nav-summary|preferences|proxy-host-insights|log-parser|waf-log-parser|access-list-[^/]*|background-jobs)\.tsx?$/;

/**
 * The area of the semantic review a file belongs to, so the review list can
 * be split between reviewers: R1 models; R2 identity and sign-in; R3 configuration, sync and jobs;
 * R4 SCIM and access reviews; R5 tenancy, roles, SSO, approvals, white-label;
 * R6 monetization, high availability, fleet; R7 compliance,
 * history, audit, backups, AI, SAML, LDAP, licensing;
 * app / src-other / ee-other / tests for the rest.
 */
export function areaOf(rel: string): string {
  if (rel.startsWith("tests/")) return "tests";
  if (rel.startsWith("src/lib/models/")) return "R1";
  if (R2_FILES.test(rel) || rel.startsWith("src/lib/services/") || rel === "proxy.ts") return "R2";
  if (R3_FILES.test(rel) || /^src\/lib\/(attention|analytics)\//.test(rel) || rel === "src/instrumentation.ts") return "R3";
  if (/^ee\/(scim|access-reviews)\//.test(rel)) return "R4";
  if (/^ee\/(multi-tenancy|custom-roles|sso|approvals|white-label)\//.test(rel)) return "R5";
  if (/^ee\/(monetization|high-availability|fleet)\//.test(rel)) return "R6";
  if (/^ee\/(compliance|config-history|audit|backups|ai|saml|ldap|licensing)\//.test(rel)) return "R7";
  if (rel.startsWith("app/")) return "app";
  if (rel.startsWith("src/")) return "src-other";
  if (rel.startsWith("ee/")) return "ee-other";
  return "other";
}

export interface LoadProgramOptions {
  /** Repository root (tsconfig.json and the path aliases are read from there). */
  root?: string;
  /** Files to start from instead of the tsconfig's include list. */
  rootNames?: readonly string[];
  /** Extra in-memory files (absolute path -> text), layered over the disk (tests). */
  overlay?: ReadonlyMap<string, string>;
}

/** Builds the program from the repository's tsconfig.json. */
export function loadProgram(options: LoadProgramOptions = {}): ts.Program {
  const root = options.root ?? REPO_ROOT;
  const configPath = resolve(root, "tsconfig.json");
  const config = ts.readConfigFile(configPath, (path) => ts.sys.readFile(path));
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root, undefined, configPath);
  // Incremental build info and the Next.js language-service plugin are of no
  // use here; .next/types only exists after a build.
  const compilerOptions: ts.CompilerOptions = { ...parsed.options, incremental: false, tsBuildInfoFile: undefined, plugins: [] };
  const rootNames = options.rootNames
    ? [...options.rootNames]
    : parsed.fileNames.filter((name) => !relPath(name, root).startsWith(".next/"));
  const host = ts.createCompilerHost(compilerOptions, true);
  const overlay = options.overlay;
  if (overlay && overlay.size > 0) {
    const getSourceFile = host.getSourceFile.bind(host);
    const fileExists = host.fileExists.bind(host);
    const readFile = host.readFile.bind(host);
    host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) => {
      const text = overlay.get(resolve(fileName));
      if (text !== undefined) return ts.createSourceFile(fileName, text, languageVersion, true);
      return getSourceFile(fileName, languageVersion, onError, shouldCreate);
    };
    host.fileExists = (fileName) => overlay.has(resolve(fileName)) || fileExists(fileName);
    host.readFile = (fileName) => overlay.get(resolve(fileName)) ?? readFile(fileName);
    // Module resolution skips directories that do not exist on disk.
    const overlayDirectories = new Set<string>();
    for (const fileName of overlay.keys()) {
      for (let directory = dirname(fileName); directory !== dirname(directory); directory = dirname(directory)) overlayDirectories.add(directory);
    }
    const directoryExists = host.directoryExists?.bind(host);
    host.directoryExists = (directoryName) => overlayDirectories.has(resolve(directoryName)) || (directoryExists ? directoryExists(directoryName) : ts.sys.directoryExists(directoryName));
  }
  return ts.createProgram({ rootNames, options: compilerOptions, host });
}
