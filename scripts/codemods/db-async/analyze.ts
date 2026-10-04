/**
 * Writes the DB closure (closure.ts) to db-async-closure.json and prints
 * summary counts. Changes no source file.
 *
 * Usage:
 *   bun run codemod:db-async:analyze [--out docs/db-async-closure.json]
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { analyzeClosure } from "./closure";
import { loadProgram, REPO_ROOT } from "./project";
import { closureJson, printSummary } from "./report";
import { rewrite } from "./rewrite";

function gitHead(): string | undefined {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
}

function main(argv: string[]): void {
  let out = "docs/db-async-closure.json";
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === "--out") out = argv[++index];
    else if (argv[index] === "--help" || argv[index] === "-h") {
      console.log("Usage: bun run codemod:db-async:analyze [--out docs/db-async-closure.json]");
      return;
    } else {
      console.error(`Unknown argument ${argv[index]}`);
      process.exit(2);
    }
  }
  const started = Date.now();
  const program = loadProgram();
  const closure = analyzeClosure(program);
  // The rewrite (in memory, nothing is written) adds the SQL findings.
  rewrite(closure);
  const json = closureJson(closure, { generatedAt: new Date().toISOString(), base: gitHead() });
  const target = resolve(REPO_ROOT, out);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(json, null, 2)}\n`);
  printSummary(json.summary);
  console.log(`\nWrote ${out} in ${((Date.now() - started) / 1000).toFixed(1)} s`);
}

main(process.argv.slice(2));
