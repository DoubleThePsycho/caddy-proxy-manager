/**
 * Finds every permission guard of the routes, pages and server actions:
 * requirePermission("<permission>") and requireApiPermission(request,
 * "<permission>"), with the function that calls it.
 * tests/unit/permission-call-sites.test.ts compares the result with the
 * table in ee/docs/custom-roles.md.
 *
 * A route or page of a paid feature is a shim in app/ that re-exports its
 * implementation from ee/ (ee/boundary.ts): its guards are found in the ee/
 * module and listed under the app/ file, which names the URL. Guards in other
 * ee/ modules (server actions of paid pages) are listed under the ee/ file.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

export type CallSite = { file: string; fn: string; permission: string; line: number };

const ROOT = process.cwd();

function walk(dir: string, out: string[]): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(path);
  }
  return out;
}

const GUARD = /\brequire(?:Api)?Permission\(\s*(?:[A-Za-z_$][\w$]*\s*,\s*)?(["'])([a-z0-9_]+:[a-z]+)\1\s*\)/g;
const ANY_GUARD_CALL = /\brequire(?:Api)?Permission\(/g;
const FUNCTION = /(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g;

const SHIM_EXPORT = /^export\s*\{[^}]*\}\s*from\s*["']@\/(ee\/[^"']+)["'];?\s*$/gm;

/** The ee/ files an app/ file re-exports from (repository-relative), in order. */
export function shimTargets(source: string): string[] {
  const targets: string[] = [];
  for (const match of source.matchAll(SHIM_EXPORT)) {
    const base = match[1];
    const file = [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`].find((candidate) => existsSync(join(ROOT, candidate)));
    if (!file) throw new Error(`cannot resolve @/${base}`);
    targets.push(file);
  }
  return targets;
}

/** A file's source and, for a shim, the source of the ee/ modules it re-exports. */
export function implementationSource(file: string): string {
  const source = readFileSync(join(ROOT, file), 'utf8');
  return [source, ...shimTargets(source).map((target) => readFileSync(join(ROOT, target), 'utf8'))].join('\n');
}

/**
 * Every guard call in app/ (through the shims into ee/) and in the rest of
 * ee/, in file order. Throws on a guard without a literal permission.
 */
export function findPermissionCallSites(root: string = join(ROOT, 'app'), eeRoot: string = join(ROOT, 'ee')): CallSite[] {
  const sites: CallSite[] = [];
  const routed = new Set<string>();
  for (const path of walk(root, []).sort()) {
    const file = relative(ROOT, path);
    const source = readFileSync(path, 'utf8');
    scan(file, source, sites);
    for (const target of shimTargets(source)) {
      routed.add(target);
      scan(file, readFileSync(join(ROOT, target), 'utf8'), sites);
    }
  }
  for (const path of walk(eeRoot, []).sort()) {
    const file = relative(ROOT, path);
    if (!routed.has(file)) scan(file, readFileSync(path, 'utf8'), sites);
  }
  return sites;
}

/** The guards in `source`, listed under `file`. */
function scan(file: string, source: string, sites: CallSite[]): void {
  const functions = [...source.matchAll(FUNCTION)].map((match) => ({ name: match[1], index: match.index! }));
  const literal = [...source.matchAll(GUARD)];
  const calls = [...source.matchAll(ANY_GUARD_CALL)].filter((match) => {
    // Skip import lines and type positions.
    const lineStart = source.lastIndexOf('\n', match.index!) + 1;
    return !/^\s*import\b/.test(source.slice(lineStart, match.index!));
  });
  if (calls.length !== literal.length) {
    throw new Error(`${file}: every permission guard must name a literal permission`);
  }
  for (const match of literal) {
    const enclosing = functions.filter((fn) => fn.index < match.index!).pop();
    sites.push({
      file,
      fn: enclosing?.name ?? '(module)',
      permission: match[2],
      line: source.slice(0, match.index!).split('\n').length,
    });
  }
}

/** "file | function | permission" rows, one per guard. */
export function callSiteKey(site: Pick<CallSite, 'file' | 'fn' | 'permission'>): string {
  return `${site.file} | ${site.fn} | ${site.permission}`;
}

/**
 * The call-site table of ee/docs/custom-roles.md: rows of the form
 * `| \`file\` | \`function\` | \`permission\` |` between the markers.
 */
export function readDocumentedCallSites(markdown: string): string[] {
  const start = markdown.indexOf('<!-- call-sites:start -->');
  const end = markdown.indexOf('<!-- call-sites:end -->');
  if (start < 0 || end < start) throw new Error('call-site table markers not found');
  return markdown
    .slice(start, end)
    .split('\n')
    .map((line) => line.match(/^\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|/))
    .filter((match): match is RegExpMatchArray => match !== null)
    .map((match) => callSiteKey({ file: match[1], fn: match[2], permission: match[3] }));
}
