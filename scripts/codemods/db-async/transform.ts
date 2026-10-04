/**
 * The db-async codemod: converts code from the synchronous Drizzle API to
 * the asynchronous database layer (src/lib/db/README.md). See README.md in
 * this directory.
 *
 * Usage:
 *   bun run codemod:db-async [--dry-run | --check | --write] [--scope production|tests|all]
 *                            [--out-dir <dir>] [--report <file.json>] [--review] [--await-unawaited] [path ...]
 *
 *   --dry-run   (default) print what would change and the manual sites; write nothing
 *   --check     exit 1 when any file would change or a manual site is still pending
 *   --write     rewrite the files in place
 *   --out-dir   write the rewritten files under <dir> instead (mirrors the paths)
 *   --report    write the counts, the changed files and every risky site as JSON
 *   --review    also list the sites to review (converted, but listed for a semantic review)
 *   --scope     production (src, app, ee, proxy.ts; the default), tests, or all
 *   --await-unawaited  also await calls to async database functions whose promise is dropped or
 *               used as a value (for code merged from a base older than the conversion)
 *   path ...    only these files or directories (prefixes, or globs with *)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { analyzeClosure } from "./closure";
import { loadProgram, REPO_ROOT, scopeOf } from "./project";
import { printFindings, serializeFinding, summarize, printSummary, type SerializedFinding } from "./report";
import { mapOffset, rewrite } from "./rewrite";

type Mode = "dry-run" | "check" | "write";

interface Options {
  mode: Mode;
  scope: "production" | "tests" | "all";
  outDir?: string;
  report?: string;
  review: boolean;
  awaitUnawaited: boolean;
  paths: string[];
}

function parseArgs(argv: string[]): Options {
  const options: Options = { mode: "dry-run", scope: "production", review: false, awaitUnawaited: false, paths: [] };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--dry-run") options.mode = "dry-run";
    else if (arg === "--check") options.mode = "check";
    else if (arg === "--write") options.mode = "write";
    else if (arg === "--review") options.review = true;
    else if (arg === "--await-unawaited") options.awaitUnawaited = true;
    else if (arg === "--out-dir") options.outDir = argv[++index];
    else if (arg === "--report") options.report = argv[++index];
    else if (arg === "--scope") {
      const scope = argv[++index];
      if (scope !== "production" && scope !== "tests" && scope !== "all") throw new Error(`Unknown scope ${scope}`);
      options.scope = scope;
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: bun run codemod:db-async [--dry-run | --check | --write] [--scope production|tests|all] [--out-dir <dir>] [--report <file.json>] [--review] [--await-unawaited] [path ...]"
      );
      process.exit(0);
    } else if (arg.startsWith("--")) throw new Error(`Unknown option ${arg}`);
    else options.paths.push(arg.replace(/^\.\//, ""));
  }
  return options;
}

export function pathFilter(paths: readonly string[], scope: Options["scope"]): (file: string) => boolean {
  const patterns = paths.map((path) => {
    if (path.includes("*")) {
      // ** matches across directories, * within one.
      const source = path
        .split(/\*\*\/?/)
        .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*"))
        .join(".*");
      const regex = new RegExp(`^${source}$`);
      return (file: string) => regex.test(file);
    }
    const prefix = path.replace(/\/$/, "");
    return (file: string) => file === prefix || file.startsWith(`${prefix}/`);
  });
  return (file: string) => {
    const fileScope = scopeOf(file);
    if (fileScope === "other") return false;
    if (scope !== "all" && fileScope !== scope) return false;
    return patterns.length === 0 || patterns.some((matches) => matches(file));
  };
}

function lineAndColumn(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  for (let index = 0; index < offset; index++) {
    if (text.charCodeAt(index) === 10) {
      line++;
      lineStart = index + 1;
    }
  }
  return { line, column: offset - lineStart + 1 };
}

function main(argv: string[]): void {
  let options: Options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(2);
  }
  const started = Date.now();
  const include = pathFilter(options.paths, options.scope);
  const program = loadProgram();
  const closure = analyzeClosure(program, { awaitUnawaited: options.awaitUnawaited });
  const result = rewrite(closure, { include });

  const changed = result.files.filter((file) => !file.error);
  const failed = result.files.filter((file) => file.error);
  const byFile = new Map(result.files.map((file) => [file.file, file]));
  // Positions in the rewritten text once written.
  const findings: SerializedFinding[] = result.findings
    .filter((finding) => include(finding.file) || finding.kind === "excluded-file")
    .map((finding) => {
      const file = byFile.get(finding.file);
      if (!file || file.error || options.mode === "dry-run" && !options.outDir) return serializeFinding(finding);
      const { line, column } = lineAndColumn(file.after, mapOffset(file.edits, finding.node.getStart()));
      return serializeFinding(finding, line, column);
    });

  const summary = summarize(closure);
  printSummary(summary);
  console.log(`\nSelection: ${changed.length} file(s) change, ${changed.reduce((n, f) => n + f.edits.length, 0)} edit(s)` +
    (result.outsideSelection > 0 ? `; ${result.outsideSelection} call(s) to await are in files outside the selection` : ""));
  for (const file of failed) console.error(`  could not rewrite ${file.file}: ${file.error}`);

  const manual = findings.filter((finding) => finding.manual);
  console.log(`\nManual sites (${manual.length}); positions are ${options.mode === "dry-run" && !options.outDir ? "in the current source" : "in the rewritten files"}:`);
  printFindings(findings, console.log, true);
  if (options.review) {
    console.log(`\nSites to review (${findings.length - manual.length}):`);
    printFindings(findings.filter((finding) => !finding.manual), console.log, false);
  }

  if (options.outDir) {
    for (const file of changed) {
      const target = resolve(options.outDir, file.file);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, file.after);
    }
    console.log(`\nWrote ${changed.length} file(s) under ${options.outDir}`);
  }
  if (options.mode === "write") {
    for (const file of changed) writeFileSync(resolve(REPO_ROOT, file.file), file.after);
    console.log(`\nRewrote ${changed.length} file(s).`);
  }
  if (options.report) {
    const target = resolve(REPO_ROOT, options.report);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify({
      generatedAt: new Date().toISOString(),
      mode: options.mode,
      scope: options.scope,
      paths: options.paths,
      summary,
      files: changed.map((file) => ({ file: file.file, edits: file.edits.length })),
      failed: failed.map((file) => ({ file: file.file, error: file.error })),
      findings,
    }, null, 2)}\n`);
    console.log(`Wrote ${options.report}`);
  }
  console.log(`\nDone in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  if (failed.length > 0) process.exit(1);
  if (options.mode === "check") {
    const pending = findings.filter((finding) => finding.kind === "pending-manual");
    if (changed.length > 0) {
      console.error(`\n${changed.length} file(s) still use the synchronous database API:`);
      for (const file of changed) console.error(`  ${file.file}`);
    }
    if (pending.length > 0) console.error(`\n${pending.length} await(s) inside functions that are not async are left to restructure.`);
    if (changed.length > 0 || pending.length > 0) process.exit(1);
  }
}

if (import.meta.main ?? process.argv[1]?.endsWith("transform.ts")) main(process.argv.slice(2));
