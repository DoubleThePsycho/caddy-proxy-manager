/**
 * The repository is ingres-si/ingressi. It was fuomag9/caddy-proxy-manager,
 * then ingres-si/caddy-proxy-manager; GitHub redirects both, but links in the
 * repository use the current name. The legacy image names
 * (ghcr.io/fuomag9/caddy-proxy-manager-*) are not GitHub repository URLs and
 * stay where they are: existing installs pull them.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DOCUMENTATION_URL } from '@/src/lib/brand';

const ROOT = process.cwd();
const OLD_NAME = 'caddy-proxy-manager';

/** A GitHub URL (web, git, API or raw) of a repository with the old name. */
const OLD_REPO_URL = new RegExp(String.raw`(?:github\.com|githubusercontent\.com)[/:](?:repos/)?[\w.-]+/` + OLD_NAME, 'i');

/** Never tracked (.gitignore): skipped when the tree is walked instead. */
const IGNORED_NAMES = new Set(['.git', 'node_modules', '.next', 'test-results', 'playwright-report']);
const IGNORED_PATHS = new Set([
  'out', 'dist', 'data', 'docs', '.idea', '.playwright-mcp', '.worktrees', '.superpowers',
  'caddy-data', 'caddy-config', 'geoip-data', 'public/maplibre', 'tests/.auth',
]);

function walk(dir: string, out: string[]): string[] {
  for (const entry of readdirSync(join(ROOT, dir))) {
    const path = dir ? `${dir}/${entry}` : entry;
    if (IGNORED_NAMES.has(entry) || IGNORED_PATHS.has(path)) continue;
    if (entry.startsWith('.env') && entry !== '.env.example') continue;
    if (statSync(join(ROOT, path)).isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

/**
 * The files git tracks, plus new ones it does not ignore. Without a git
 * checkout (the test VM syncs the tree without .git), every file outside the
 * ignored directories.
 */
function repositoryFiles(): string[] {
  try {
    const listed = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
    });
    return [...new Set(listed.split('\0').filter(Boolean))].filter((file) => existsSync(join(ROOT, file)));
  } catch {
    return walk('', []);
  }
}

/** The file's text, or null for a binary file. */
function readText(file: string): string | null {
  const buffer = readFileSync(join(ROOT, file));
  return buffer.subarray(0, 8000).includes(0) ? null : buffer.toString('utf8');
}

describe('links to the GitHub repository', () => {
  it('never use the old repository name', () => {
    const files = repositoryFiles();
    expect(files).toContain('README.md');
    expect(files).toContain('src/lib/brand.ts');
    const found: string[] = [];
    for (const file of files) {
      const text = readText(file);
      if (text === null) continue;
      text.split('\n').forEach((line, index) => {
        if (OLD_REPO_URL.test(line)) found.push(`${file}:${index + 1}: ${line.trim()}`);
      });
    }
    expect(found).toEqual([]);
  });

  it('recognise repository URLs of the old name, and not the legacy image names', () => {
    expect(OLD_REPO_URL.test(['https://github.com', 'ingres-si', OLD_NAME, 'issues'].join('/'))).toBe(true);
    expect(OLD_REPO_URL.test(`git@github.com:fuomag9/${OLD_NAME}.git`)).toBe(true);
    expect(OLD_REPO_URL.test(`https://api.github.com/repos/fuomag9/${OLD_NAME}`)).toBe(true);
    expect(OLD_REPO_URL.test(`https://raw.githubusercontent.com/fuomag9/${OLD_NAME}/develop/README.md`)).toBe(true);
    expect(OLD_REPO_URL.test(`ghcr.io/fuomag9/${OLD_NAME}-web:latest`)).toBe(false);
    expect(OLD_REPO_URL.test('https://github.com/ingres-si/ingressi/issues')).toBe(false);
  });

  it('publish the documentation from the renamed repository', () => {
    expect(DOCUMENTATION_URL).toBe('https://github.com/ingres-si/ingressi/blob/develop');
  });
});
