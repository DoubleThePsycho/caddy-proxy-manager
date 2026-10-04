/**
 * Serialises the DB closure (closure.ts) for db-async-closure.json and
 * prints the summaries of analyze.ts and transform.ts.
 */
import { isExcluded } from "./project";
import { MANUAL_KINDS, RISK_DESCRIPTIONS, type Closure, type Finding, type Member, type RiskKind } from "./closure";

export function memberId(member: Member): string {
  return `${member.file}:${member.line}:${member.column}`;
}

export interface SerializedMember {
  id: string;
  name: string;
  kind: string;
  file: string;
  line: number;
  column: number;
  area: string;
  /** Already async (a signature: already returns a Promise). */
  async: boolean;
  /** Synchronous today; becomes async (a signature: returns a Promise). */
  converts: boolean;
  /** Cannot be made async (a risky context); its sites are in `risky`. */
  blocked?: string;
  excluded: boolean;
  inTransaction: boolean;
  reads: boolean;
  writes: boolean;
  why: Array<{ kind: string; detail: string; at: string }>;
  callers: Array<{ at: string; function?: string }>;
}

export interface SerializedFinding {
  kind: RiskKind;
  manual: boolean;
  file: string;
  line: number;
  column: number;
  area: string;
  message: string;
  code: string;
  function?: string;
}

export function serializeMember(member: Member): SerializedMember {
  return {
    id: memberId(member),
    name: member.name,
    kind: member.kind,
    file: member.file,
    line: member.line,
    column: member.column,
    area: member.area,
    async: member.alreadyAsync,
    converts: member.converts,
    ...(member.blocked ? { blocked: member.blocked } : {}),
    excluded: member.excluded,
    inTransaction: member.inTransaction,
    reads: member.reads,
    writes: member.writes,
    why: member.reasons.map((r) => ({ kind: r.kind, detail: r.detail, at: r.at })),
    callers: member.callers.map((c) => ({ at: c.at, ...(c.member ? { function: memberId(c.member) } : {}) })),
  };
}

export function serializeFinding(finding: Finding, line = finding.line, column = finding.column): SerializedFinding {
  return {
    kind: finding.kind,
    manual: finding.manual,
    file: finding.file,
    line,
    column,
    area: finding.area,
    message: finding.message,
    code: finding.code,
    ...(finding.member ? { function: memberId(finding.member) } : {}),
  };
}

function byPosition<T extends { file: string; line: number; column: number }>(a: T, b: T): number {
  return a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column;
}

export function closureJson(closure: Closure, meta: Record<string, unknown>) {
  const members = [...closure.members.values()].sort(byPosition);
  const findings = [...closure.findings].sort(byPosition);
  return {
    ...meta,
    summary: summarize(closure),
    riskKinds: Object.fromEntries(Object.entries(RISK_DESCRIPTIONS).map(([kind, text]) => [kind, { manual: MANUAL_KINDS.has(kind as RiskKind), text }])),
    functions: {
      production: members.filter((m) => m.scope === "production").map(serializeMember),
      tests: members.filter((m) => m.scope === "tests").map(serializeMember),
    },
    risky: {
      production: findings.filter((f) => f.scope === "production").map((f) => serializeFinding(f)),
      tests: findings.filter((f) => f.scope === "tests").map((f) => serializeFinding(f)),
    },
  };
}

function count<T>(items: Iterable<T>, key: (item: T) => string | undefined): Record<string, number> {
  const result: Record<string, number> = {};
  for (const item of items) {
    const k = key(item);
    if (k === undefined) continue;
    result[k] = (result[k] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(result).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

export function summarize(closure: Closure) {
  const scopes = ["production", "tests"] as const;
  const out: Record<string, unknown> = {};
  for (const scope of scopes) {
    const inScope = (file: string) => (scope === "tests" ? file.startsWith("tests/") : !file.startsWith("tests/"));
    const sites = [...closure.dbSites.values()].filter((s) => inScope(fileOf(closure, s.node)) && !isExcluded(fileOf(closure, s.node)));
    const members = [...closure.members.values()].filter((m) => m.scope === scope);
    const awaitSites = [...closure.awaitSites.values()].filter((s) => inScope(fileOf(closure, s.node)) && !isExcluded(fileOf(closure, s.node)));
    const findings = closure.findings.filter((f) => f.scope === scope);
    const touched = new Set<string>();
    for (const s of sites) if (s.sync || !s.awaited) touched.add(fileOf(closure, s.node));
    for (const s of awaitSites) if (!s.skip) touched.add(fileOf(closure, s.node));
    for (const m of members) if (m.converts) touched.add(m.file);
    out[scope] = {
      dbSites: {
        total: sites.length,
        synchronous: sites.filter((s) => s.sync).length,
        byKind: count(sites.filter((s) => s.sync), (s) => s.kind),
        alreadyAwaited: sites.filter((s) => s.awaited).length,
      },
      functions: {
        reachTheDatabase: members.filter((m) => !m.excluded).length,
        convertToAsync: members.filter((m) => m.converts && m.kind !== "signature").length,
        signaturesToPromise: members.filter((m) => m.converts && m.kind === "signature").length,
        alreadyAsync: members.filter((m) => m.alreadyAsync).length,
        blocked: count(members.filter((m) => m.blocked), (m) => m.blocked),
        byArea: count(members.filter((m) => m.converts), (m) => m.area),
      },
      callsToAwait: awaitSites.filter((s) => !s.skip).length,
      // The functions whose conversion awaits the most calls.
      hubs: Object.entries(count(awaitSites, (s) => `${s.target.name} (${s.target.file})`)).slice(0, 12).map(([name, calls]) => ({ name, calls })),
      filesTouched: touched.size,
      risky: {
        manual: findings.filter((f) => f.manual).length,
        review: findings.filter((f) => !f.manual).length,
        byKind: count(findings, (f) => f.kind),
        manualByArea: count(findings.filter((f) => f.manual), (f) => f.area),
      },
    };
  }
  return out;
}

function fileOf(closure: Closure, node: { getSourceFile(): { fileName: string } }): string {
  const name = node.getSourceFile().fileName;
  return name.startsWith(`${closure.root}/`) ? name.slice(closure.root.length + 1) : name;
}

export function printSummary(summary: ReturnType<typeof summarize>, log: (line: string) => void = console.log): void {
  for (const [scope, value] of Object.entries(summary)) {
    const s = value as {
      dbSites: { total: number; synchronous: number; byKind: Record<string, number>; alreadyAwaited: number };
      functions: { reachTheDatabase: number; convertToAsync: number; signaturesToPromise: number; alreadyAsync: number; blocked: Record<string, number>; byArea: Record<string, number> };
      callsToAwait: number;
      hubs: Array<{ name: string; calls: number }>;
      filesTouched: number;
      risky: { manual: number; review: number; byKind: Record<string, number>; manualByArea: Record<string, number> };
    };
    log(`\n[${scope}]`);
    log(`  Drizzle sites: ${s.dbSites.total} (${s.dbSites.synchronous} synchronous: ${fmt(s.dbSites.byKind)}; ${s.dbSites.alreadyAwaited} already awaited)`);
    log(`  Functions reaching the database: ${s.functions.reachTheDatabase} (${s.functions.alreadyAsync} already async)`);
    log(`  Become async: ${s.functions.convertToAsync} functions, ${s.functions.signaturesToPromise} signatures; blocked: ${fmt(s.functions.blocked) || "none"}`);
    log(`  By area: ${fmt(s.functions.byArea)}`);
    log(`  Calls to await: ${s.callsToAwait}; files touched: ${s.filesTouched}`);
    log(`  Most awaited: ${s.hubs.map((h) => `${h.name} ${h.calls}`).join(", ")}`);
    log(`  Risky contexts: ${s.risky.manual} manual, ${s.risky.review} to review`);
    log(`    by kind: ${fmt(s.risky.byKind)}`);
    log(`    manual by area: ${fmt(s.risky.manualByArea)}`);
  }
}

function fmt(record: Record<string, number>): string {
  return Object.entries(record).map(([k, v]) => `${k} ${v}`).join(", ");
}

export function printFindings(findings: readonly SerializedFinding[], log: (line: string) => void = console.log, onlyManual = true): void {
  const groups = new Map<string, SerializedFinding[]>();
  for (const finding of findings) {
    if (onlyManual && !finding.manual) continue;
    const list = groups.get(finding.kind) ?? [];
    list.push(finding);
    groups.set(finding.kind, list);
  }
  for (const [kind, list] of [...groups.entries()].sort((a, b) => b[1].length - a[1].length)) {
    log(`\n${kind} (${list.length}): ${RISK_DESCRIPTIONS[kind as RiskKind]}`);
    for (const finding of list.sort(byPosition)) log(`  ${finding.file}:${finding.line}:${finding.column}  ${finding.code}`);
  }
}
