/**
 * The license boundary (ee/boundary.ts, ee/README.md): every source file
 * under ee/ is Elastic-2.0, every file under an ee/ route prefix in app/ only
 * routes to ee/ (a shim), and core files outside app/ that import ee/ are
 * listed with the reason.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CORE_EE_HOOKS, EE_ROUTE_PREFIXES, EE_ROUTES } from '@/ee/boundary';

const ROOT = process.cwd();

function files(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(join(ROOT, dir))) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const path = join(dir, entry);
    if (statSync(join(ROOT, path)).isDirectory()) files(path, out);
    else out.push(path.split('\\').join('/'));
  }
  return out.sort();
}

const read = (file: string) => readFileSync(join(ROOT, file), 'utf8');

const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts|css|sql|sh)$/;
const CODE = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;

/** The first line, or the second after a shebang. */
function headerLine(source: string): string {
  const lines = source.split('\n');
  return lines[0].startsWith('#!') ? lines[1] ?? '' : lines[0];
}

describe('ee/', () => {
  const sources = files('ee').filter((file) => SOURCE.test(file));

  it('has sources to check', () => {
    expect(sources.length).toBeGreaterThan(500);
  });

  it('starts every source file with the Elastic-2.0 SPDX header', () => {
    const SPDX = /^(?:\/\/|\/\*|#|--) SPDX-License-Identifier: Elastic-2\.0(?: \*\/)?$/;
    const missing = sources.filter((file) => !SPDX.test(headerLine(read(file))));
    expect(missing, 'add "// SPDX-License-Identifier: Elastic-2.0" as the first line').toEqual([]);
  });

  it('never imports from app/ (app/ only routes to ee/)', () => {
    const offending = sources
      .filter((file) => CODE.test(file))
      .flatMap((file) =>
        read(file)
          .split('\n')
          .map((line, index) => ({ line, index }))
          .filter(({ line }) => /["']@\/app\/|["'](?:\.\.\/)+app\//.test(line))
          .map(({ line, index }) => `${file}:${index + 1}: ${line.trim()}`)
      );
    expect(offending).toEqual([]);
  });
});

const SEGMENT_CONFIG = ['dynamic', 'dynamicParams', 'revalidate', 'fetchCache', 'runtime', 'preferredRegion', 'maxDuration'];
const ROUTE_EXPORTS = ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'];
const PAGE_EXPORTS = ['default', 'metadata', 'generateMetadata', 'viewport', 'generateViewport', 'generateStaticParams'];
const PAGE_FILES = /^(page|layout|template|default|loading|error|not-found)\.tsx?$/;

function moduleFile(specifier: string): string | null {
  const base = specifier.slice(2);
  return [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`].find((candidate) => existsSync(join(ROOT, candidate))) ?? null;
}

/**
 * What keeps `file` from being a shim of `module`, as "file:line: problem"
 * strings: anything but the SPDX line, the comment naming the ee/ file,
 * `export { … } from "@/ee/…"` statements and literal segment config.
 */
function shimProblems(file: string, module: string): string[] {
  const name = file.slice(file.lastIndexOf('/') + 1);
  const allowed = name === 'route.ts' ? ROUTE_EXPORTS : PAGE_FILES.test(name) ? PAGE_EXPORTS : null;
  if (!allowed) return [`${file}: only route and page files may stay in app/; move it to ${module}/`];
  const lines = read(file).split('\n');
  const problems: string[] = [];
  const at = (index: number, problem: string) => problems.push(`${file}:${index + 1}: ${problem}`);
  if (lines[0] !== '// SPDX-License-Identifier: MIT') at(0, 'the first line must be "// SPDX-License-Identifier: MIT"');
  const named = /^\/\/ .*?(ee\/\S+)/.exec(lines[1] ?? '')?.[1].replace(/[.,;:)]+$/, '').replace(/\.tsx?$/, '');
  if (!named) at(1, 'the second line must be a comment naming the ee/ file it routes to');
  const targets: string[] = [];
  lines.forEach((raw, index) => {
    const line = raw.trim();
    if (index < 2 || line === '' || line.startsWith('//')) return;
    const reexport = /^export \{ ([\w, ]+) \} from "(@\/ee\/[^"]+)";$/.exec(line);
    if (reexport) {
      for (const exported of reexport[1].split(',').map((part) => part.trim())) {
        if (!allowed.includes(exported)) at(index, `"${exported}" is not a ${name} export Next.js reads`);
      }
      const target = moduleFile(reexport[2]);
      if (!target) at(index, `${reexport[2]} does not exist`);
      else if (!target.startsWith(`${module}/`)) at(index, `routes to ${target}, outside ${module}/`);
      else targets.push(target);
      return;
    }
    const segment = /^export const (\w+) = ("[^"]*"|'[^']*'|\d+|true|false);$/.exec(line);
    if (segment && SEGMENT_CONFIG.includes(segment[1])) return;
    at(index, `not a re-export from ee/ or literal segment config: ${line}`);
  });
  if (targets.length === 0) at(0, `re-exports nothing from ${module}/`);
  if (named && targets.length > 0 && !targets.some((target) => target.replace(/\.tsx?$/, '') === named)) {
    at(1, `names ${named}, which it does not re-export from`);
  }
  return problems;
}

describe('ee/ routes and pages in app/', () => {
  const appFiles = files('app');
  const groupOf = (file: string) =>
    EE_ROUTES.find((group) => group.prefixes.some((prefix) => (prefix.endsWith('/') ? file.startsWith(prefix) : file === prefix)));
  const shims = appFiles.filter((file) => groupOf(file));

  it('lists prefixes that exist, once each', () => {
    expect(new Set(EE_ROUTE_PREFIXES).size).toBe(EE_ROUTE_PREFIXES.length);
    for (const prefix of EE_ROUTE_PREFIXES) {
      expect(appFiles.some((file) => (prefix.endsWith('/') ? file.startsWith(prefix) : file === prefix)), prefix).toBe(true);
    }
    for (const group of EE_ROUTES) expect(existsSync(join(ROOT, group.module)), group.module).toBe(true);
  });

  it('has shims to check', () => {
    expect(shims.length).toBeGreaterThan(180);
  });

  it('keeps only shims under the ee/ prefixes', () => {
    expect(shims.flatMap((file) => shimProblems(file, groupOf(file)!.module))).toEqual([]);
  });
});

describe('core code', () => {
  const core = [...files('app'), ...files('src'), 'proxy.ts'].filter((file) => CODE.test(file));

  it('lists every file outside app/ that imports ee/ in CORE_EE_HOOKS, with a reason', () => {
    const importing = core
      .filter((file) => !file.startsWith('app/'))
      .filter((file) => /["']@\/ee\/|["'](?:\.\.\/)+ee\//.test(read(file)));
    const listed = Object.keys(CORE_EE_HOOKS).sort();
    expect(importing.filter((file) => !(file in CORE_EE_HOOKS)), 'add these to CORE_EE_HOOKS in ee/boundary.ts').toEqual([]);
    expect(listed.filter((file) => !importing.includes(file)), 'remove these from CORE_EE_HOOKS').toEqual([]);
    for (const [file, reason] of Object.entries(CORE_EE_HOOKS)) expect(reason.length, file).toBeGreaterThan(15);
  });
});
