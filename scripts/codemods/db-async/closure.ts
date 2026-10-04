/**
 * The "DB closure": every function, method, callback, signature and
 * module-level initializer that reaches the database, found with the type
 * checker, and what the move to the asynchronous database API
 * (src/lib/db/README.md) has to do to each of them.
 *
 * Roots are Drizzle SQLite calls that run synchronously: the terminals
 * `.get()`, `.all()`, `.run()`, `.values()` of query builders, raw
 * `db.run/all/get/values(sql)`, and `transaction(fn)` with a synchronous
 * callback. Whatever receiver they are called on (the default `db`, a `tx`
 * parameter, a `SyncDatabase` alias, a `Pick<…>` of one) is recognised by the
 * declaration the call resolves to, never by a variable's name.
 *
 * From the roots the closure grows to a fixpoint:
 * - a synchronous function with a root, or with a call to a function that
 *   becomes asynchronous, becomes asynchronous itself and the call is awaited;
 * - a callback that becomes asynchronous changes the signature it is typed by:
 *   a signature declared in this repository returns a Promise (its calls are
 *   awaited and its other implementations become asynchronous); a generic
 *   library or wrapper signature whose result follows the callback's makes
 *   that outer call return a Promise, so it is awaited;
 * - a class method changes the interface member or base method it implements;
 * - functions that are already asynchronous and reach the database are in the
 *   closure too (they need no change; their callers are listed).
 *
 * Contexts where inserting `await` and `async` cannot preserve the behaviour
 * are not converted and are reported as risky (see RISK_KINDS). The rewrite
 * (rewrite.ts) still awaits the calls inside them, without making the
 * function asynchronous, so the compiler stops at each one until a person
 * restructures it.
 */
import ts from "typescript";
import { areaOf, isAnalyzed, isExcluded, relPath, REPO_ROOT, scopeOf, type Scope } from "./project";

// ── Vocabulary ──

export type RiskKind =
  // Manual: the transform cannot convert the site; `tsc` stops there after the rewrite.
  | "array-callback"
  | "accessor"
  | "constructor"
  | "class-field"
  | "parameter-default"
  | "generator"
  | "type-predicate"
  | "exit-handler"
  | "signal-handler"
  | "void-callback"
  | "sync-callback"
  | "function-value"
  | "jsx-callback"
  | "client-component"
  | "module-level"
  | "excluded-file"
  | "raw-client"
  | "run-result"
  | "values-terminal"
  | "prepared-statement"
  | "raw-sql-result"
  | "sqlite-sql"
  | "driver-error"
  | "runtime-sqlite-core"
  | "sync-db-type"
  | "unawaited-async-call"
  | "pending-manual"
  // Review: converted mechanically, listed for a semantic review.
  | "boolean-context"
  | "void-call"
  | "recursion"
  | "server-component"
  | "generic-wrapper"
  | "like-semantics"
  | "json-text"
  | "check-then-act"
  | "floating-async-call"
  | "promise-combinator"
  | "signature-change";

export const MANUAL_KINDS: ReadonlySet<RiskKind> = new Set<RiskKind>([
  "array-callback", "accessor", "constructor", "class-field", "parameter-default", "generator", "type-predicate",
  "exit-handler", "signal-handler", "void-callback", "sync-callback", "function-value", "jsx-callback",
  "client-component", "module-level", "excluded-file", "raw-client", "run-result", "values-terminal",
  "prepared-statement", "raw-sql-result", "sqlite-sql", "driver-error", "runtime-sqlite-core", "sync-db-type",
  "unawaited-async-call", "pending-manual",
]);

export const RISK_DESCRIPTIONS: Readonly<Record<RiskKind, string>> = {
  "array-callback": "callback of .map/.filter/.sort/.some/.every/.find/.reduce/.forEach (or Array.from) that must await: rewrite as a loop or Promise.all, and decide the order",
  accessor: "getter or setter that reaches the database: accessors cannot be async; turn it into a method",
  constructor: "constructor that reaches the database: constructors cannot await; use an async factory",
  "class-field": "class field initializer that reaches the database: initializers cannot await",
  "parameter-default": "parameter default that reaches the database: parameter initializers cannot await",
  generator: "generator that reaches the database: needs an async generator or a rewrite",
  "type-predicate": "type predicate or assertion function that reaches the database: async functions cannot narrow; return a value and narrow at the caller",
  "exit-handler": "process exit hook: it cannot wait for a promise; flush on SIGTERM/SIGINT instead and await it",
  "signal-handler": "signal handler: an async handler must keep the process alive until it is done",
  "void-callback": "callback whose result is ignored (timer, event, promise executor): async changes error handling and ordering; catch and log inside",
  "sync-callback": "callback of a library or excluded signature that must return a plain value",
  "function-value": "function value passed or stored where the transform cannot follow its calls",
  "jsx-callback": "function passed through JSX: client code cannot await the database",
  "client-component": "client component or module (\"use client\") that reaches the database",
  "module-level": "module-level code that reaches the database: move it into an awaited start-up or a lazy async getter",
  "excluded-file": "call from a file the codemod never changes (src/lib/db/**, ee/high-availability/cluster/**, ClickHouse): await it by hand",
  "raw-client": "raw driver client ($client): use the executor (src/lib/db) instead",
  "run-result": "the result of .run() is used (changes / lastInsertRowid): use .returning() and count rows",
  "values-terminal": ".values() terminal: select the columns and map the rows",
  "prepared-statement": "prepared statement with placeholders: await the builder with the values inlined",
  "raw-sql-result": "raw db.run/all/get/values(sql): use execRaw (rows as objects) and check the result shape",
  "sqlite-sql": "SQLite-only SQL in a sql`` template: use a helper from src/lib/db/ops.ts",
  "driver-error": "SQLite driver error code or message: use isUniqueViolation/isConstraintViolation/isReadOnlyError",
  "runtime-sqlite-core": "runtime import from drizzle-orm/sqlite-core outside src/lib/db: use referencesTo or another db helper",
  "sync-db-type": "synchronous Drizzle database type the transform does not know: use AppDb/AppTx/DbExecutor",
  "unawaited-async-call": "call to an asynchronous database function used as a value (boolean, property access) without await",
  "pending-manual": "await inside a function that is not async (left by an earlier run): restructure it",
  "boolean-context": "awaited call in a condition (if/!/&&/||/?:): a forgotten await here is a silent security bug; add a negative test",
  "void-call": "`void f()` of a function that became async was turned into `await f()`; check that fire-and-forget was not intended",
  recursion: "recursive function that became async",
  "server-component": "React server component that became async",
  "generic-wrapper": "async callback passed to a generic wrapper of this repository: the wrapper now awaits it and became async; check what it does around the call (locks, try/catch, transactions)",
  "like-semantics": "LIKE turned into containsText/likeText: %, _ and \\ in the input are now literal",
  "json-text": "json_extract without a cast turned into jsonTextAt, which returns text: numbers and booleans come back as text",
  "check-then-act": "reads then writes outside a transaction: atomic while synchronous, interleaves once async; wrap it in appDb.transaction",
  "floating-async-call": "call to an asynchronous database function whose promise is dropped (no await, no void)",
  "promise-combinator": "call left un-awaited inside Promise.all/allSettled/race/any",
  "signature-change": "signature declared here now returns a Promise; every implementation became async",
};

export type MemberKind =
  | "function"
  | "method"
  | "arrow"
  | "function-expression"
  | "getter"
  | "setter"
  | "constructor"
  | "signature";

export type ReasonKind =
  | "terminal"
  | "raw-sql"
  | "transaction"
  | "transaction-callback"
  | "awaits-builder"
  | "db-helper"
  | "calls"
  | "implements"
  | "implemented-by"
  | "receives-async-callback"
  | "contains-manual-site";

export interface Reason {
  kind: ReasonKind;
  detail: string;
  at: string;
}

export type DbSiteKind = "get" | "all" | "run" | "values" | "raw-run" | "raw-all" | "raw-get" | "raw-values" | "transaction";
export type ReceiverKind = "select" | "insert" | "update" | "delete" | "query" | "database" | "other";

/** A Drizzle SQLite call: a terminal, raw SQL, or a transaction. */
export interface DbSite {
  node: ts.CallExpression;
  kind: DbSiteKind;
  receiver: ReceiverKind;
  /** Runs synchronously today (the default db); false on the async facade. */
  sync: boolean;
  awaited: boolean;
  /** `.get()` on a builder that still has `.limit()`. */
  addLimit: boolean;
  /** `.get()` typed without undefined (`.returning().get()`): keep that type. */
  nonUndefined: boolean;
  /** The value of the call is used. */
  resultUsed: boolean;
}

/** A call that returns a Promise after the conversion and must be awaited. */
export interface AwaitSite {
  node: ts.CallExpression | ts.NewExpression;
  /** Why: the member called, or the async callback that makes a generic call async. */
  target: Member;
  /** `void f()` → `await f()`. */
  replaceVoid: boolean;
  /** Not awaited: inside Promise.all & co., where the promise is wanted. */
  skip: boolean;
}

export interface Member {
  node: ts.SignatureDeclaration;
  kind: MemberKind;
  name: string;
  file: string;
  line: number;
  column: number;
  scope: Scope;
  area: string;
  excluded: boolean;
  /** Already async (or, for a signature, already returns a Promise). */
  alreadyAsync: boolean;
  /** Synchronous today and becomes asynchronous (a signature: returns a Promise). */
  converts: boolean;
  /** Why it cannot be made async, when it cannot. */
  blocked?: RiskKind;
  reasons: Reason[];
  /** Call sites (file:line) and the members they are in. */
  callers: Array<{ at: string; member?: Member }>;
  reads: boolean;
  writes: boolean;
  /** Inside a transaction callback (lexically). */
  inTransaction: boolean;
}

export interface Finding {
  kind: RiskKind;
  manual: boolean;
  file: string;
  line: number;
  column: number;
  scope: Scope;
  area: string;
  message: string;
  /** The code at the site (one line, shortened). */
  code: string;
  member?: Member;
  node: ts.Node;
}

export interface Closure {
  program: ts.Program;
  checker: ts.TypeChecker;
  root: string;
  members: Map<ts.Node, Member>;
  dbSites: Map<ts.CallExpression, DbSite>;
  awaitSites: Map<ts.Node, AwaitSite>;
  findings: Finding[];
  /** The default `db` export of src/lib/db.ts (to rename to appDb). */
  syncDbSymbol: ts.Symbol | undefined;
  /** Files with something to convert. */
  files: Set<string>;
}

export interface AnalyzeOptions {
  root?: string;
  /**
   * Also await calls to asynchronous database functions whose promise is
   * dropped (a statement without `void`) or used as a value (`if (f())`,
   * `f().x`): code merged from a base older than the conversion calls them
   * the synchronous way. Off by default: on the base being converted such a
   * statement may be a deliberate fire-and-forget.
   */
  awaitUnawaited?: boolean;
}

// ── Small helpers ──

const FACADE_MODULE = "src/lib/db.ts";
const DB_LAYER = /^src\/lib\/db(\.ts|\/)/;

const ARRAY_METHODS = new Set([
  "map", "filter", "find", "findIndex", "findLast", "findLastIndex", "some", "every", "reduce", "reduceRight",
  "sort", "toSorted", "flatMap", "forEach",
]);
const ARRAY_LIKE_TYPES = new Set([
  "Array", "ReadonlyArray", "Set", "ReadonlySet", "Map", "ReadonlyMap", "IterableIterator", "IteratorObject",
  "MapIterator", "SetIterator", "ArrayIterator", "Iterator", "Generator",
]);
const PROMISE_COMBINATORS = new Set(["all", "allSettled", "race", "any"]);
const EXIT_EVENTS = new Set(["exit", "beforeExit"]);
const EMITTER_METHODS = new Set(["on", "once", "addListener", "prependListener", "prependOnceListener"]);

/** DB-layer functions that run queries: reaching them means reaching the database. */
const DB_LAYER_QUERY_FUNCTIONS = new Set([
  "first", "execRaw", "resyncIdentity", "withClusterLock", "purgeDeletedDatabaseContent", "runDatabaseStartup",
]);

export function isFunctionWithBody(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node)
  ) && node.body !== undefined;
}

export function hasAsyncModifier(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);
}

/** Skips parentheses, `as`, `satisfies` and `!` upwards. */
export function outerExpression(node: ts.Node): ts.Node {
  let current = node;
  while (
    current.parent &&
    (ts.isParenthesizedExpression(current.parent) ||
      ts.isAsExpression(current.parent) ||
      ts.isSatisfiesExpression(current.parent) ||
      ts.isNonNullExpression(current.parent) ||
      ts.isTypeAssertionExpression(current.parent))
  ) {
    current = current.parent;
  }
  return current;
}

export function isAwaited(node: ts.Node): boolean {
  const outer = outerExpression(node);
  return outer.parent !== undefined && ts.isAwaitExpression(outer.parent);
}

function isDeclarationFileNode(node: ts.Node): boolean {
  const sf = node.getSourceFile();
  return sf.isDeclarationFile || sf.fileName.includes("/node_modules/");
}

function isDrizzleSqliteDeclaration(node: ts.Node | undefined): boolean {
  if (!node) return false;
  return /\/node_modules\/drizzle-orm\/(sqlite-core|bun-sqlite|better-sqlite3|sqlite-proxy)\//.test(
    node.getSourceFile().fileName.split("\\").join("/")
  );
}

/** The statement-ish line of a node, for findings. */
function siteCode(node: ts.Node, sf: ts.SourceFile): string {
  let current: ts.Node = node;
  while (current.parent && !ts.isStatement(current) && !ts.isClassElement(current) && current.parent.kind !== ts.SyntaxKind.SourceFile) {
    if (ts.isBlock(current.parent)) break;
    current = current.parent;
    if (current.getText(sf).length > 160) break;
  }
  const text = (current.getText(sf).length <= 160 ? current : node).getText(sf).replace(/\s+/g, " ").trim();
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

function memberKindOf(node: ts.SignatureDeclaration): MemberKind {
  if (ts.isFunctionDeclaration(node)) return "function";
  if (ts.isMethodDeclaration(node)) return node.body ? "method" : "signature";
  if (ts.isArrowFunction(node)) return "arrow";
  if (ts.isFunctionExpression(node)) return "function-expression";
  if (ts.isGetAccessorDeclaration(node)) return "getter";
  if (ts.isSetAccessorDeclaration(node)) return "setter";
  if (ts.isConstructorDeclaration(node)) return "constructor";
  return "signature";
}

function propertyNameText(name: ts.PropertyName | ts.BindingName | undefined): string | undefined {
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return undefined;
}

function calleeName(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return undefined;
}

function memberName(node: ts.SignatureDeclaration): string {
  if (ts.isFunctionDeclaration(node)) return node.name?.text ?? "default";
  if (ts.isConstructorDeclaration(node)) {
    const cls = node.parent;
    return `${(ts.isClassLike(cls) && cls.name?.text) || "class"}.constructor`;
  }
  if (ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node) || ts.isMethodSignature(node)) {
    const owner = node.parent;
    const name = propertyNameText(node.name) ?? "[computed]";
    if (ts.isClassLike(owner) || ts.isInterfaceDeclaration(owner)) return `${owner.name?.text ?? "class"}.${name}`;
    if (ts.isObjectLiteralExpression(owner) || ts.isTypeLiteralNode(owner)) {
      const holder = outerExpression(owner).parent;
      if (holder && ts.isVariableDeclaration(holder)) return `${propertyNameText(holder.name) ?? "{}"}.${name}`;
      if (holder && ts.isTypeAliasDeclaration(holder)) return `${holder.name.text}.${name}`;
      return `{}.${name}`;
    }
    return name;
  }
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    if (ts.isFunctionExpression(node) && node.name) return node.name.text;
    const use = outerExpression(node);
    const parent = use.parent;
    if (!parent) return "<anonymous>";
    if (ts.isVariableDeclaration(parent)) return propertyNameText(parent.name) ?? "<destructured>";
    if (ts.isPropertyAssignment(parent)) return propertyNameText(parent.name) ?? "<property>";
    if (ts.isPropertyDeclaration(parent)) return propertyNameText(parent.name) ?? "<field>";
    if (ts.isCallExpression(parent) || ts.isNewExpression(parent)) {
      const callee = parent.expression.getText().replace(/\s+/g, "");
      const shortCallee = callee.length > 60 ? `…${callee.slice(-59)}` : callee;
      const index = (parent.arguments ?? ts.factory.createNodeArray()).indexOf(use as ts.Expression);
      return `${shortCallee}(callback #${index + 1})`;
    }
    if (ts.isReturnStatement(parent) || ts.isArrowFunction(parent)) return "<returned function>";
    if (ts.isExportAssignment(parent)) return "default";
    return "<anonymous>";
  }
  if (ts.isFunctionTypeNode(node) || ts.isCallSignatureDeclaration(node)) {
    let holder: ts.Node = node.parent;
    while (holder && (ts.isParenthesizedTypeNode(holder) || ts.isUnionTypeNode(holder) || ts.isTypeLiteralNode(holder))) holder = holder.parent;
    if (holder && (ts.isParameter(holder) || ts.isPropertySignature(holder) || ts.isPropertyDeclaration(holder) || ts.isVariableDeclaration(holder))) {
      const owner = ts.isParameter(holder) && ts.isFunctionLike(holder.parent) && holder.parent.name
        ? `${propertyNameText(holder.parent.name as ts.PropertyName) ?? "fn"}(` : "";
      return `${owner}${propertyNameText(holder.name) ?? "fn"}${owner ? ")" : ""}`;
    }
    if (holder && ts.isTypeAliasDeclaration(holder)) return holder.name.text;
    return "<signature>";
  }
  return "<signature>";
}

// ── The analysis ──

export function analyzeClosure(program: ts.Program, options: AnalyzeOptions = {}): Closure {
  const root = options.root ?? REPO_ROOT;
  const checker = program.getTypeChecker();
  const rel = (sf: ts.SourceFile) => relPath(sf.fileName, root);

  const sourceFiles = program
    .getSourceFiles()
    .filter((sf) => !sf.isDeclarationFile && !sf.fileName.includes("/node_modules/") && isAnalyzed(rel(sf)));
  const sourceFileSet = new Set(sourceFiles);

  const members = new Map<ts.Node, Member>();
  const dbSites = new Map<ts.CallExpression, DbSite>();
  const awaitSites = new Map<ts.Node, AwaitSite>();
  const findings: Finding[] = [];
  const findingKeys = new Set<string>();
  const files = new Set<string>();

  const isProjectNode = (node: ts.Node) => sourceFileSet.has(node.getSourceFile());
  const isExcludedNode = (node: ts.Node) => isExcluded(rel(node.getSourceFile()));
  const position = (node: ts.Node) => {
    const sf = node.getSourceFile();
    const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    return { file: rel(sf), line: line + 1, column: character + 1 };
  };
  const at = (node: ts.Node) => {
    const p = position(node);
    return `${p.file}:${p.line}:${p.column}`;
  };

  function addFinding(kind: RiskKind, node: ts.Node, message?: string, member?: Member): void {
    const p = position(node);
    const key = `${kind}|${p.file}|${p.line}|${p.column}`;
    if (findingKeys.has(key)) return;
    findingKeys.add(key);
    const sf = node.getSourceFile();
    findings.push({
      kind,
      manual: MANUAL_KINDS.has(kind),
      ...p,
      scope: scopeOf(p.file),
      area: areaOf(p.file),
      message: message ?? RISK_DESCRIPTIONS[kind],
      code: siteCode(node, sf),
      member,
      node,
    });
  }

  // The default `db` of the facade (src/lib/db.ts).
  let syncDbSymbol: ts.Symbol | undefined;
  const facade = program.getSourceFile(`${root}/${FACADE_MODULE}`);
  if (facade) {
    const moduleSymbol = checker.getSymbolAtLocation(facade);
    const exported = moduleSymbol ? checker.getExportsOfModule(moduleSymbol) : [];
    const defaultExport = exported.find((symbol) => symbol.escapedName === "default");
    if (defaultExport) syncDbSymbol = resolveAlias(defaultExport);
  }

  function resolveAlias(symbol: ts.Symbol): ts.Symbol {
    return symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  }

  // ── Pass 1: index calls, identifiers and function expressions ──

  /** Normalised declaration → calls that resolve to it. */
  const callsTo = new Map<ts.Node, Array<ts.CallExpression | ts.NewExpression>>();
  /** Identifier text → identifiers (references, not declaration names). */
  const identifiersByText = new Map<string, ts.Identifier[]>();
  /** Signature declaration → function expressions / methods contextually typed by it, and class methods implementing it. */
  const implementations = new Map<ts.Node, ts.SignatureDeclaration[]>();
  /**
   * Function values passed on by name into a source signature (an argument,
   * a property or a typed variable): signature → the declarations of the
   * values' own signatures. When the signature returns a Promise, so must they.
   */
  const forwardedInto = new Map<ts.Node, Set<ts.SignatureDeclaration>>();
  /** Await expressions whose operand is a Drizzle builder (already async code). */
  const awaitedBuilders: ts.AwaitExpression[] = [];
  const dbLayerCalls: Array<ts.CallExpression> = [];
  const nonAsyncAwaits: ts.AwaitExpression[] = [];

  function normalizeDeclaration(declaration: ts.Declaration | undefined): ts.Node | undefined {
    if (!declaration) return undefined;
    if ((ts.isFunctionDeclaration(declaration) || ts.isMethodDeclaration(declaration)) && !declaration.body && declaration.name) {
      const symbol = checker.getSymbolAtLocation(declaration.name);
      const implementation = symbol?.declarations?.find(
        (d) => (ts.isFunctionDeclaration(d) || ts.isMethodDeclaration(d)) && d.body !== undefined
      );
      if (implementation) return implementation;
    }
    return declaration;
  }

  function addImplementation(signature: ts.Node, implementation: ts.SignatureDeclaration): void {
    const list = implementations.get(signature);
    if (list) {
      if (!list.includes(implementation)) list.push(implementation);
    } else implementations.set(signature, [implementation]);
  }

  /** The source signature declaration that contextually types a function expression or object method. */
  function contextualSignatureDeclaration(fn: ts.SignatureDeclaration): ts.SignatureDeclaration | undefined {
    let type: ts.Type | undefined;
    if (ts.isMethodDeclaration(fn) && ts.isObjectLiteralExpression(fn.parent)) {
      const objectType = checker.getContextualType(fn.parent);
      const name = propertyNameText(fn.name);
      if (!objectType || !name) return undefined;
      const property = checker.getPropertyOfType(objectType, name);
      if (!property) return undefined;
      type = checker.getTypeOfSymbolAtLocation(property, fn);
    } else if (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) {
      type = checker.getContextualType(fn);
    }
    if (!type) return undefined;
    const signatures = checker.getNonNullableType(type).getCallSignatures();
    if (signatures.length !== 1) return undefined;
    const declaration = signatures[0].getDeclaration() as ts.SignatureDeclaration | undefined;
    if (!declaration || declaration === fn) return undefined;
    return declaration;
  }

  function heritageMembers(method: ts.MethodDeclaration): ts.Declaration[] {
    const cls = method.parent;
    const name = propertyNameText(method.name);
    if (!ts.isClassLike(cls) || !name) return [];
    const result: ts.Declaration[] = [];
    for (const clause of cls.heritageClauses ?? []) {
      for (const typeNode of clause.types) {
        const type = checker.getTypeAtLocation(typeNode);
        const property = checker.getPropertyOfType(type, name);
        for (const declaration of property?.declarations ?? []) result.push(declaration);
      }
    }
    return result;
  }

  for (const sf of sourceFiles) {
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const signature = checker.getResolvedSignature(node);
        const declaration = normalizeDeclaration(signature?.getDeclaration());
        if (declaration) {
          const list = callsTo.get(declaration);
          if (list) list.push(node);
          else callsTo.set(declaration, [node]);
          if (ts.isCallExpression(node)) {
            classifyDbCall(node, declaration);
            const declRel = isDeclarationFileNode(declaration) ? "" : rel(declaration.getSourceFile());
            if (DB_LAYER.test(declRel) && DB_LAYER_QUERY_FUNCTIONS.has(calleeName(node.expression) ?? "")) dbLayerCalls.push(node);
            if (calleeName(node.expression) === "transaction" && DB_LAYER.test(declRel)) dbLayerCalls.push(node);
          }
        }
      } else if (ts.isIdentifier(node)) {
        const parent = node.parent;
        const isDeclarationName =
          parent &&
          (ts.isFunctionDeclaration(parent) || ts.isVariableDeclaration(parent) || ts.isMethodDeclaration(parent) ||
            ts.isParameter(parent) || ts.isPropertyAssignment(parent) || ts.isClassDeclaration(parent) ||
            ts.isInterfaceDeclaration(parent) || ts.isTypeAliasDeclaration(parent) || ts.isPropertyDeclaration(parent) ||
            ts.isMethodSignature(parent) || ts.isPropertySignature(parent) || ts.isImportSpecifier(parent) ||
            ts.isImportClause(parent) || ts.isNamespaceImport(parent) || ts.isGetAccessorDeclaration(parent) ||
            ts.isSetAccessorDeclaration(parent)) &&
          (parent as ts.NamedDeclaration).name === node;
        if (!isDeclarationName) {
          const list = identifiersByText.get(node.text);
          if (list) list.push(node);
          else identifiersByText.set(node.text, [node]);
        }
      } else if (ts.isAwaitExpression(node)) {
        const operand = node.expression;
        const thenSymbol = checker.getPropertyOfType(checker.getTypeAtLocation(operand), "then");
        if (thenSymbol?.declarations?.some((d) => /\/node_modules\/drizzle-orm\//.test(d.getSourceFile().fileName))) {
          awaitedBuilders.push(node);
        }
        const context = enclosingContext(node);
        if (context.fn && !hasAsyncModifier(context.fn)) nonAsyncAwaits.push(node);
      }
      if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node) || (ts.isMethodDeclaration(node) && ts.isObjectLiteralExpression(node.parent))) && node.body) {
        const declaration = contextualSignatureDeclaration(node);
        if (declaration && isProjectNode(declaration)) addImplementation(declaration, node);
      }
      if ((ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) && isValuePosition(node)) recordForwarding(node);
      if (ts.isMethodDeclaration(node) && node.body && ts.isClassLike(node.parent)) {
        for (const declaration of heritageMembers(node)) {
          const signature = ts.isPropertySignature(declaration) || ts.isPropertyDeclaration(declaration)
            ? functionTypeOfProperty(declaration)
            : declaration;
          if (signature && isProjectNode(signature)) addImplementation(signature, node);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  /** An argument, a property value or a typed variable's value. */
  function isValuePosition(node: ts.Expression): boolean {
    const outer = outerExpression(node);
    const parent = outer.parent;
    if (!parent) return false;
    if (ts.isCallExpression(parent) || ts.isNewExpression(parent)) {
      return parent.expression !== outer && (parent.arguments ?? ts.factory.createNodeArray<ts.Expression>()).includes(outer as ts.Expression);
    }
    if (ts.isPropertyAssignment(parent)) return parent.initializer === outer;
    if (ts.isShorthandPropertyAssignment(parent)) return true;
    if (ts.isVariableDeclaration(parent)) return parent.initializer === outer && parent.type !== undefined;
    return false;
  }

  function singleSignatureDeclaration(type: ts.Type | undefined): ts.SignatureDeclaration | undefined {
    if (!type) return undefined;
    const signatures = checker.getNonNullableType(type).getCallSignatures();
    if (signatures.length !== 1) return undefined;
    return signatures[0].getDeclaration() as ts.SignatureDeclaration | undefined;
  }

  function recordForwarding(node: ts.Identifier | ts.PropertyAccessExpression): void {
    const outer = outerExpression(node) as ts.Expression;
    const target = ts.isShorthandPropertyAssignment(outer.parent)
      ? (() => {
          const objectType = checker.getContextualType(outer.parent.parent as ts.ObjectLiteralExpression);
          const property = objectType ? checker.getPropertyOfType(objectType, outer.parent.name.text) : undefined;
          return property ? singleSignatureDeclaration(checker.getTypeOfSymbolAtLocation(property, outer)) : undefined;
        })()
      : singleSignatureDeclaration(checker.getContextualType(outer));
    if (!target || !isProjectNode(target) || isExcludedNode(target) || isFunctionWithBody(target)) return;
    const source = singleSignatureDeclaration(checker.getTypeAtLocation(node));
    if (!source || source === target || !isProjectNode(source) || isExcludedNode(source)) return;
    const set = forwardedInto.get(target) ?? new Set<ts.SignatureDeclaration>();
    set.add(source);
    forwardedInto.set(target, set);
  }

  function functionTypeOfProperty(property: ts.PropertySignature | ts.PropertyDeclaration): ts.SignatureDeclaration | undefined {
    const type = property.type;
    if (type && ts.isFunctionTypeNode(type)) return type;
    return undefined;
  }

  // ── Drizzle calls ──

  function classifyDbCall(call: ts.CallExpression, declaration: ts.Node): void {
    if (!ts.isPropertyAccessExpression(call.expression)) return;
    const name = call.expression.name.text;
    if (!["get", "all", "run", "values", "transaction"].includes(name)) return;
    const sf = call.getSourceFile();
    if (!isDrizzleSqliteDeclaration(declaration)) {
      // The facade's own transaction() (src/lib/db/types.ts, the default
      // export since the conversion) called the synchronous way, with a
      // callback that is not async, as code written before the conversion
      // does: converted like Drizzle's synchronous transaction().
      if (name !== "transaction" || !isProjectNode(call)) return;
      if (isDeclarationFileNode(declaration) || !DB_LAYER.test(rel(declaration.getSourceFile()))) return;
      const callback = call.arguments[0];
      const fn = callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) ? callback : undefined;
      if (!fn || fn.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)) return;
      const outer = outerExpression(call);
      dbSites.set(call, {
        node: call,
        kind: "transaction",
        receiver: "database",
        sync: true,
        awaited: isAwaited(call),
        addLimit: false,
        nonUndefined: false,
        resultUsed: !(outer.parent && ts.isExpressionStatement(outer.parent)),
      });
      files.add(rel(sf));
      return;
    }
    if (!isProjectNode(call)) return;
    const resultType = checker.getTypeAtLocation(call);
    const sync = !isThenable(resultType);
    const receiverType = checker.getTypeAtLocation(call.expression.expression);
    const receiverName = (receiverType.getSymbol() ?? receiverType.aliasSymbol)?.getName() ?? "";
    let receiver: ReceiverKind = builderKind(call.expression.expression, receiverType);
    const declarationClass = declaration.parent && ts.isClassLike(declaration.parent) ? declaration.parent.name?.text ?? "" : "";
    const onDatabase = /BaseSQLiteDatabase|SQLiteTransaction|Database$/.test(declarationClass) || receiver === "other" && /Database|Transaction/.test(receiverName);
    // insert(t).values(rows) is the insert builder, not the .values() terminal.
    if (name === "values" && call.arguments.length > 0 && !onDatabase) return;
    let kind: DbSiteKind;
    if (name === "transaction") kind = "transaction";
    else if (call.arguments.length > 0 && onDatabase) kind = `raw-${name}` as DbSiteKind;
    else kind = name as DbSiteKind;
    if (kind === "transaction" || kind.startsWith("raw-")) receiver = "database";
    const outer = outerExpression(call);
    const resultUsed = !(outer.parent && ts.isExpressionStatement(outer.parent));
    let addLimit = false;
    let nonUndefined = false;
    if (kind === "get") {
      addLimit = receiver === "select" && checker.getPropertyOfType(receiverType, "limit") !== undefined;
      const valueType = sync ? resultType : checker.getAwaitedType(resultType) ?? resultType;
      // `.get()!` already asserts it; the `!` stays where it is.
      const asserted = !!call.parent && ts.isNonNullExpression(call.parent);
      nonUndefined = !asserted && !(valueType.isUnion() && valueType.types.some((t) => (t.flags & ts.TypeFlags.Undefined) !== 0)) &&
        (valueType.flags & ts.TypeFlags.Undefined) === 0 && (valueType.flags & ts.TypeFlags.Any) === 0;
    }
    dbSites.set(call, { node: call, kind, receiver, sync, awaited: isAwaited(call), addLimit, nonUndefined, resultUsed });
    files.add(rel(sf));
  }

  /** What a builder chain does: the method that started it, else what its type offers. */
  function builderKind(expression: ts.Expression, type: ts.Type): ReceiverKind {
    let current: ts.Expression = expression;
    while (true) {
      while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isNonNullExpression(current)) current = current.expression;
      if (ts.isCallExpression(current) && ts.isPropertyAccessExpression(current.expression)) {
        const name = current.expression.name.text;
        if (name === "select" || name === "selectDistinct" || name === "selectDistinctOn") return "select";
        if (name === "insert") return "insert";
        if (name === "update") return "update";
        if (name === "delete") return "delete";
        if (name === "findFirst" || name === "findMany") return "query";
        current = current.expression.expression;
        continue;
      }
      if (ts.isPropertyAccessExpression(current)) {
        current = current.expression;
        continue;
      }
      break;
    }
    const has = (name: string) => checker.getPropertyOfType(type, name) !== undefined;
    if (has("set")) return "update";
    if (has("onConflictDoNothing") || has("values")) return "insert";
    if (has("groupBy") || has("having") || has("innerJoin")) return "select";
    if (has("where") && has("returning")) return "delete";
    const name = (type.getSymbol() ?? type.aliasSymbol)?.getName() ?? "";
    if (/RelationalQuery/.test(name)) return "query";
    return "other";
  }

  function isThenable(type: ts.Type): boolean {
    if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return false;
    if (type.isUnion()) {
      const members = type.types.filter((t) => !(t.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Void)));
      return members.length > 0 && members.some((t) => isThenable(t));
    }
    return checker.getPropertyOfType(type, "then") !== undefined;
  }

  /** The return type admits a Promise: any, unknown, a thenable in it, or a type parameter. */
  function admitsPromise(type: ts.Type): boolean {
    if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)) return true;
    if (type.isUnion()) return type.types.some((t) => admitsPromise(t));
    return isThenable(type);
  }

  function isVoidLike(type: ts.Type): boolean {
    if (type.flags & (ts.TypeFlags.Void | ts.TypeFlags.Undefined)) return true;
    if (type.isUnion()) return type.types.every((t) => (t.flags & (ts.TypeFlags.Void | ts.TypeFlags.Undefined)) !== 0);
    return false;
  }

  // ── Contexts ──

  interface EnclosingContext {
    fn?: ts.FunctionLikeDeclaration;
    via?: "parameter-default" | "class-field" | "module-level";
  }

  function enclosingContext(node: ts.Node): EnclosingContext {
    let previous: ts.Node = node;
    let current: ts.Node | undefined = node.parent;
    while (current) {
      if (isFunctionWithBody(current)) {
        if (ts.isParameter(previous) && current.parameters.includes(previous)) return { fn: current, via: "parameter-default" };
        return { fn: current };
      }
      if (ts.isPropertyDeclaration(current) && previous === current.initializer) return { via: "class-field" };
      if (ts.isSourceFile(current)) return { via: "module-level" };
      previous = current;
      current = current.parent;
    }
    return { via: "module-level" };
  }

  function isInsideTransactionCallback(node: ts.Node): boolean {
    let current: ts.Node | undefined = node;
    while (current) {
      if (isFunctionWithBody(current) && transactionCallbacks.has(current)) return true;
      current = current.parent;
    }
    return false;
  }

  const transactionCallbacks = new Set<ts.Node>();

  function isClientFile(sf: ts.SourceFile): boolean {
    const first = sf.statements[0];
    return !!first && ts.isExpressionStatement(first) && ts.isStringLiteral(first.expression) && first.expression.text === "use client";
  }

  function returnsJsx(fn: ts.FunctionLikeDeclaration): boolean {
    if (!fn.getSourceFile().fileName.endsWith(".tsx")) return false;
    let found = false;
    const visit = (node: ts.Node) => {
      if (found) return;
      if (node !== fn && isFunctionWithBody(node)) return;
      if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) {
        found = true;
        return;
      }
      ts.forEachChild(node, visit);
    };
    if (fn.body) visit(fn.body);
    return found;
  }

  interface UseClassification {
    blocked?: RiskKind;
    /** Array callbacks: the call whose enclosing function takes over the conversion. */
    passThrough?: ts.Node;
    /** A source signature the function implements (it changes with it). */
    signature?: ts.SignatureDeclaration;
    /** A call whose result follows the callback's and so becomes a Promise. */
    genericCall?: ts.CallExpression | ts.NewExpression;
    /** That generic call's callee is declared in this repository. */
    genericWrapper?: string;
    transactionCallback?: boolean;
    note?: string;
  }

  /** How a function value at `use` (an expression position) is consumed. */
  function classifyFunctionUse(use: ts.Node, fn: ts.SignatureDeclaration | undefined): UseClassification {
    const outer = outerExpression(use);
    const parent = outer.parent;
    if (!parent) return {};
    // An immediately invoked function: its call resolves to it and is awaited.
    if (ts.isCallExpression(parent) && parent.expression === outer) return {};
    if ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.expression !== outer) {
      return classifyCallback(parent, (parent.arguments ?? ts.factory.createNodeArray()).indexOf(outer as ts.Expression), outer as ts.Expression);
    }
    if (ts.isVariableDeclaration(parent) && parent.initializer === outer) {
      if (parent.type) return classifyBySignatureType(checker.getTypeFromTypeNode(parent.type), fn);
      return {};
    }
    if (ts.isPropertyAssignment(parent) || ts.isShorthandPropertyAssignment(parent)) {
      const objectLiteral = parent.parent;
      const contextual = checker.getContextualType(objectLiteral);
      const name = propertyNameText(parent.name);
      if (!contextual || !name) return {};
      const property = checker.getPropertyOfType(contextual, name);
      if (!property) return {};
      return classifyBySignatureType(checker.getTypeOfSymbolAtLocation(property, parent), fn);
    }
    if (ts.isReturnStatement(parent) || (ts.isArrowFunction(parent) && parent.body === outer)) return {};
    if (ts.isPropertyDeclaration(parent) || ts.isExportAssignment(parent) || ts.isExportSpecifier(parent)) return {};
    if (ts.isJsxExpression(parent) || ts.isJsxAttribute(parent)) return { blocked: "jsx-callback" };
    if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && parent.right === outer) {
      return classifyBySignatureType(checker.getTypeAtLocation(parent.left), fn);
    }
    if (ts.isTypeQueryNode(parent) || ts.isExpressionWithTypeArguments(parent)) return {};
    return { blocked: "function-value" };
  }

  /** A function typed by `type` (a variable or property type). */
  function classifyBySignatureType(type: ts.Type, fn: ts.SignatureDeclaration | undefined): UseClassification {
    const signatures = checker.getNonNullableType(type).getCallSignatures();
    if (signatures.length !== 1) return {};
    const declaration = signatures[0].getDeclaration() as ts.SignatureDeclaration | undefined;
    if (!declaration || declaration === fn) return {};
    if (isProjectNode(declaration) && !isExcludedNode(declaration)) return { signature: declaration };
    if (admitsPromise(checker.getReturnTypeOfSignature(signatures[0]))) return {};
    if (isVoidLike(checker.getReturnTypeOfSignature(signatures[0]))) return { blocked: "void-callback" };
    return { blocked: "sync-callback" };
  }

  function stringArgument(call: ts.CallExpression | ts.NewExpression, index: number): string | undefined {
    const argument = call.arguments?.[index];
    return argument && (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) ? argument.text : undefined;
  }

  function isArrayLikeReceiver(expression: ts.Expression): boolean {
    const type = checker.getNonNullableType(checker.getTypeAtLocation(expression));
    if (checker.isArrayType(type) || checker.isTupleType(type)) return true;
    const name = (type.getSymbol() ?? type.aliasSymbol)?.getName();
    return name !== undefined && ARRAY_LIKE_TYPES.has(name);
  }

  function classifyCallback(call: ts.CallExpression | ts.NewExpression, index: number, argument: ts.Expression): UseClassification {
    const callee = call.expression;
    const name = calleeName(callee);
    if (ts.isCallExpression(call) && ts.isPropertyAccessExpression(callee) && name) {
      if (ARRAY_METHODS.has(name) && isArrayLikeReceiver(callee.expression)) return { blocked: "array-callback", passThrough: call };
      if (name === "from" && ts.isIdentifier(callee.expression) && callee.expression.text === "Array" && index === 1) {
        return { blocked: "array-callback", passThrough: call };
      }
      if (EMITTER_METHODS.has(name) && ts.isIdentifier(callee.expression) && callee.expression.text === "process") {
        const event = stringArgument(call, 0) ?? "";
        if (EXIT_EVENTS.has(event)) return { blocked: "exit-handler" };
        if (event.startsWith("SIG")) return { blocked: "signal-handler" };
        return { blocked: "void-callback" };
      }
      if (name === "transaction" && dbSites.get(call)?.kind === "transaction" && index === 0) return { transactionCallback: true };
    }
    const signature = checker.getResolvedSignature(call);
    const declaration = signature?.getDeclaration() as ts.SignatureDeclaration | undefined;
    if (!signature || !declaration) return { blocked: "function-value" };
    const parameters = declaration.parameters;
    const parameter = parameters[Math.min(index, parameters.length - 1)];
    if (!parameter) return { blocked: "function-value" };
    const declaredType = parameter.type;
    const typeParameterNames = new Set((declaration.typeParameters ?? []).map((p) => p.name.text));
    // A generic callback whose result the call returns: the call's result becomes a Promise.
    const callbackReturn = declaredType && ts.isFunctionTypeNode(declaredType) ? declaredType.type : undefined;
    const genericReturn = callbackReturn && typeReferenceName(callbackReturn);
    if (genericReturn && typeParameterNames.has(genericReturn)) {
      const callReturn = declaration.type;
      const returnMentions = callReturn ? mentionsTypeParameter(callReturn, genericReturn) : false;
      const resultType = checker.getTypeAtLocation(call);
      if (!returnMentions) {
        // The callback's result is dropped by the callee (forEach-like).
        return isProjectNode(declaration) && !isExcludedNode(declaration)
          ? { signature: declaredType as ts.FunctionTypeNode }
          : { blocked: "void-callback" };
      }
      if (isThenable(resultType)) return {};
      if (isProjectNode(declaration) && !isExcludedNode(declaration)) {
        // A wrapper of this repository: its callback type returns a Promise, the
        // wrapper awaits it (and becomes async), so work after the call still
        // runs after the callback.
        return { signature: declaredType as ts.FunctionTypeNode, genericWrapper: memberName(declaration) };
      }
      return { genericCall: call };
    }
    if (declaredType && typeReferenceName(declaredType) && typeParameterNames.has(typeReferenceName(declaredType)!)) {
      // fn: T where T is the callback itself (cache(fn), expect(fn)): calls through the result
      // resolve to the callback, unless the result is not a function.
      const resultType = checker.getTypeAtLocation(call);
      if (resultType.getCallSignatures().length > 0) return {};
      return { blocked: "function-value" };
    }
    if (isProjectNode(declaration) && !isExcludedNode(declaration)) {
      const parameterType = checker.getTypeAtLocation(parameter);
      const parameterSignatures = checker.getNonNullableType(parameterType).getCallSignatures();
      if (parameterSignatures.length === 1) {
        const signatureDeclaration = parameterSignatures[0].getDeclaration() as ts.SignatureDeclaration | undefined;
        if (admitsPromise(checker.getReturnTypeOfSignature(parameterSignatures[0]))) return {};
        if (signatureDeclaration && isProjectNode(signatureDeclaration) && !isExcludedNode(signatureDeclaration)) {
          return { signature: signatureDeclaration };
        }
      }
      return { blocked: "function-value" };
    }
    // A library (or excluded) signature: does its callback contract admit a Promise?
    const contextual = checker.getContextualType(argument);
    const contextualSignatures = contextual ? checker.getNonNullableType(contextual).getCallSignatures() : [];
    if (contextualSignatures.length === 0) return { blocked: "function-value" };
    const returns = contextualSignatures.map((s) => checker.getReturnTypeOfSignature(s));
    if (returns.some((t) => admitsPromise(t))) return {};
    if (returns.every((t) => isVoidLike(t))) return { blocked: "void-callback", note: name ? `callback of ${name}()` : undefined };
    return { blocked: "sync-callback", note: name ? `callback of ${name}()` : undefined };
  }

  function typeReferenceName(node: ts.TypeNode): string | undefined {
    if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName) && !node.typeArguments) return node.typeName.text;
    return undefined;
  }

  function mentionsTypeParameter(node: ts.TypeNode, name: string): boolean {
    // Promise<T> / PromiseLike<T> results are already awaited by callers.
    if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName) && /^(Promise|PromiseLike)$/.test(node.typeName.text)) return false;
    let found = false;
    const visit = (child: ts.Node) => {
      if (found) return;
      if (ts.isTypeReferenceNode(child) && ts.isIdentifier(child.typeName) && child.typeName.text === name) found = true;
      else ts.forEachChild(child, visit);
    };
    visit(node);
    return found;
  }

  /** Whether a function-like node can be made async, and how its value is consumed. */
  function classifyFunction(node: ts.SignatureDeclaration): UseClassification {
    if (!isFunctionWithBody(node)) return {};
    if (ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) return { blocked: "accessor" };
    if (ts.isConstructorDeclaration(node)) return { blocked: "constructor" };
    if ((node as ts.FunctionDeclaration).asteriskToken) return { blocked: "generator" };
    if (node.type && ts.isTypePredicateNode(node.type)) return { blocked: "type-predicate" };
    if (isClientFile(node.getSourceFile())) return { blocked: "client-component" };
    if (transactionCallbacks.has(node)) return { transactionCallback: true };
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || (ts.isMethodDeclaration(node) && ts.isObjectLiteralExpression(node.parent))) {
      if (ts.isMethodDeclaration(node) && ts.isObjectLiteralExpression(node.parent)) {
        const signature = contextualSignatureDeclaration(node);
        if (!signature) return {};
        if (isProjectNode(signature) && !isExcludedNode(signature)) return { signature };
        const contextualObject = checker.getContextualType(node.parent);
        const property = contextualObject && propertyNameText(node.name)
          ? checker.getPropertyOfType(contextualObject, propertyNameText(node.name)!) : undefined;
        if (!property) return {};
        return classifyBySignatureType(checker.getTypeOfSymbolAtLocation(property, node), node);
      }
      return classifyFunctionUse(node, node);
    }
    return {};
  }

  // ── Propagation ──

  const queue: Member[] = [];

  function getMember(node: ts.SignatureDeclaration): Member {
    let member = members.get(node);
    if (member) return member;
    const p = position(node);
    const alreadyAsync = isFunctionWithBody(node)
      ? hasAsyncModifier(node)
      : (() => {
          const signature = checker.getSignatureFromDeclaration(node);
          return signature ? isThenable(checker.getReturnTypeOfSignature(signature)) : false;
        })();
    member = {
      node,
      kind: memberKindOf(node),
      name: memberName(node),
      ...p,
      scope: scopeOf(p.file),
      area: areaOf(p.file),
      excluded: isExcluded(p.file),
      alreadyAsync,
      converts: false,
      reasons: [],
      callers: [],
      reads: false,
      writes: false,
      inTransaction: false,
    };
    members.set(node, member);
    return member;
  }

  /** `node` reaches the database; `convert` when it is synchronous and must become async. */
  function reach(node: ts.SignatureDeclaration, reason: Reason, convert: boolean): Member {
    const isNew = !members.has(node);
    const member = getMember(node);
    if (!member.reasons.some((r) => r.kind === reason.kind && r.at === reason.at && r.detail === reason.detail)) member.reasons.push(reason);
    let flipped = false;
    if (convert && !member.alreadyAsync && !member.converts && !member.excluded && !member.blocked) {
      const classification = classifyFunction(node);
      if (classification.blocked) member.blocked = classification.blocked;
      else {
        member.converts = true;
        flipped = true;
      }
    }
    if (isNew || flipped) queue.push(member);
    return member;
  }

  const processedAs = new Map<Member, "reach" | "convert">();

  function process(member: Member): void {
    const mode = member.converts ? "convert" : "reach";
    const previous = processedAs.get(member);
    if (previous === mode || previous === "convert") return;
    processedAs.set(member, mode);
    const node = member.node;
    if (member.excluded) {
      // Excluded code stays as it is; its callers are still listed.
      for (const call of callsTo.get(node) ?? []) {
        const context = enclosingContext(call);
        member.callers.push({ at: at(call), member: context.fn ? members.get(context.fn) : undefined });
      }
      return;
    }

    if (member.converts) {
      files.add(member.file);
      const classification = classifyFunction(node);
      if (classification.signature) {
        reach(classification.signature, { kind: "implemented-by", detail: member.name, at: at(node) }, true);
        if (classification.genericWrapper) {
          addFinding("generic-wrapper", node, `${RISK_DESCRIPTIONS["generic-wrapper"]} (${classification.genericWrapper})`, member);
        }
      }
      if (classification.genericCall) {
        markAwaitSite(classification.genericCall, member);
        if (classification.genericWrapper) {
          addFinding("generic-wrapper", classification.genericCall, `${RISK_DESCRIPTIONS["generic-wrapper"]} (${classification.genericWrapper})`, member);
        }
      }
      if (ts.isMethodDeclaration(node) && ts.isClassLike(node.parent)) {
        for (const declaration of heritageMembers(node)) {
          const signature = ts.isPropertySignature(declaration) || ts.isPropertyDeclaration(declaration)
            ? functionTypeOfProperty(declaration) : (declaration as ts.SignatureDeclaration);
          if (!signature) continue;
          if (isProjectNode(signature) && !isExcludedNode(signature)) {
            reach(signature, { kind: "implemented-by", detail: member.name, at: at(node) }, true);
          } else {
            const sig = checker.getSignatureFromDeclaration(signature);
            if (sig && !admitsPromise(checker.getReturnTypeOfSignature(sig))) addFinding("sync-callback", node, `${RISK_DESCRIPTIONS["sync-callback"]} (implements ${memberName(signature)})`, member);
          }
        }
      }
      if (!isFunctionWithBody(node)) {
        // A signature now returns a Promise: every implementation becomes async.
        const impls = implementations.get(node) ?? [];
        for (const implementation of impls) {
          reach(implementation, { kind: "implements", detail: member.name, at: at(node) }, true);
        }
        for (const source of forwardedInto.get(node) ?? []) {
          reach(source, { kind: "implements", detail: `${member.name} (passed on)`, at: at(node) }, true);
        }
        if (impls.length > 0 || (callsTo.get(node)?.length ?? 0) > 0) addFinding("signature-change", node, `${RISK_DESCRIPTIONS["signature-change"]} (${impls.length} implementation(s))`, member);
      }
      if (isFunctionWithBody(node) && member.kind !== "getter" && returnsJsx(node)) addFinding("server-component", node, undefined, member);
    }

    // Calls to this member.
    for (const call of callsTo.get(node) ?? []) handleCall(call, member);
    // The member used as a value.
    if (member.converts && (isFunctionWithBody(node) || ts.isMethodSignature(node))) {
      for (const reference of valueReferences(node)) handleReference(reference, member);
    }
  }

  function addCaller(callee: Member, site: ts.Node, caller: Member | undefined): void {
    const where = at(site);
    if (!callee.callers.some((c) => c.at === where)) callee.callers.push({ at: where, member: caller });
  }

  function symbolsOf(node: ts.SignatureDeclaration): ts.Symbol[] {
    const result: ts.Symbol[] = [];
    const add = (name: ts.Node | undefined) => {
      if (!name) return;
      const symbol = checker.getSymbolAtLocation(name);
      if (symbol) result.push(symbol);
    };
    if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isMethodSignature(node)) add(node.name);
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
      const parent = outerExpression(node).parent;
      if (parent && (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent))) add(parent.name);
    }
    return result;
  }

  function valueReferences(node: ts.SignatureDeclaration): ts.Identifier[] {
    const symbols = symbolsOf(node);
    if (symbols.length === 0) return [];
    const names = new Set(symbols.map((s) => s.getName()));
    const result: ts.Identifier[] = [];
    for (const name of names) {
      for (const identifier of identifiersByText.get(name) ?? []) {
        const parent = identifier.parent;
        // Calls are handled through callsTo.
        if (ts.isCallExpression(parent) && parent.expression === identifier) continue;
        if (ts.isPropertyAccessExpression(parent) && parent.name === identifier && ts.isCallExpression(parent.parent) && parent.parent.expression === parent) continue;
        if (ts.isPropertyAccessExpression(parent) && parent.expression === identifier) continue;
        if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent) || ts.isTypeQueryNode(parent) || ts.isQualifiedName(parent)) continue;
        let symbol = ts.isShorthandPropertyAssignment(parent)
          ? checker.getShorthandAssignmentValueSymbol(parent)
          : checker.getSymbolAtLocation(identifier);
        if (!symbol) continue;
        symbol = resolveAlias(symbol);
        if (!symbols.includes(symbol)) continue;
        const reference = ts.isPropertyAccessExpression(parent) && parent.name === identifier ? parent : identifier;
        result.push(reference as ts.Identifier);
      }
    }
    return result;
  }

  function markAwaitSite(call: ts.CallExpression | ts.NewExpression, target: Member): void {
    if (awaitSites.has(call)) return;
    if (isAwaited(call)) {
      const context = enclosingContext(call);
      addCaller(target, call, context.fn ? reach(context.fn, { kind: "calls", detail: target.name, at: at(call) }, false) : undefined);
      return;
    }
    if (isExcludedNode(call)) {
      addCaller(target, call, undefined);
      addFinding("excluded-file", call, `${RISK_DESCRIPTIONS["excluded-file"]} (${target.name})`, target);
      return;
    }
    const outer = outerExpression(call);
    const replaceVoid = !!outer.parent && ts.isVoidExpression(outer.parent);
    const skip = isPromiseCombinatorElement(outer);
    awaitSites.set(call, { node: call, target, replaceVoid, skip });
    files.add(rel(call.getSourceFile()));
    if (replaceVoid) addFinding("void-call", call, undefined, target);
    if (skip) addFinding("promise-combinator", call, undefined, target);
    if (isBooleanContext(call)) addFinding("boolean-context", call, `${RISK_DESCRIPTIONS["boolean-context"]} (${target.name})`, target);
    afterAwaitInserted(call, target);
  }

  function isPromiseCombinatorElement(outer: ts.Node): boolean {
    let current = outer.parent;
    if (current && ts.isArrayLiteralExpression(current)) current = outerExpression(current).parent;
    return !!current && ts.isCallExpression(current) && ts.isPropertyAccessExpression(current.expression) &&
      ts.isIdentifier(current.expression.expression) && current.expression.expression.text === "Promise" &&
      PROMISE_COMBINATORS.has(current.expression.name.text);
  }

  function isBooleanContext(node: ts.Node): boolean {
    const outer = outerExpression(node);
    const parent = outer.parent;
    if (!parent) return false;
    if ((ts.isIfStatement(parent) || ts.isWhileStatement(parent) || ts.isDoStatement(parent)) && parent.expression === outer) return true;
    if (ts.isForStatement(parent) && parent.condition === outer) return true;
    if (ts.isConditionalExpression(parent) && parent.condition === outer) return true;
    if (ts.isPrefixUnaryExpression(parent) && parent.operator === ts.SyntaxKind.ExclamationToken) return true;
    if (ts.isBinaryExpression(parent) && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken].includes(parent.operatorToken.kind)) return true;
    if (ts.isCallExpression(parent) && ts.isIdentifier(parent.expression) && parent.expression.text === "Boolean") return true;
    return false;
  }

  /** After an await is inserted at `site`, the enclosing function must be async. */
  function afterAwaitInserted(site: ts.Node, target: Member): void {
    const context = enclosingContext(site);
    if (!context.fn) {
      addCaller(target, site, undefined);
      addFinding(context.via === "class-field" ? "class-field" : "module-level", site, undefined, target);
      return;
    }
    if (context.via === "parameter-default") addFinding("parameter-default", site, undefined, target);
    const enclosing = context.fn;
    const member = reach(enclosing, { kind: "calls", detail: target.name, at: at(site) }, true);
    addCaller(target, site, member);
    if (member.blocked) {
      addFinding(member.blocked, site, `${RISK_DESCRIPTIONS[member.blocked]} (${target.name})`, member);
      // Array callbacks: the function around the .map() call becomes async (the loop goes there).
      const classification = classifyFunction(enclosing);
      if (classification.passThrough) {
        afterManualSite(classification.passThrough, member);
      }
    }
  }

  function afterManualSite(site: ts.Node, blocked: Member): void {
    const context = enclosingContext(site);
    if (!context.fn || isExcludedNode(site)) return;
    const member = reach(context.fn, { kind: "contains-manual-site", detail: blocked.name, at: at(site) }, true);
    if (member.blocked) {
      const classification = classifyFunction(context.fn);
      if (classification.passThrough) afterManualSite(classification.passThrough, member);
    }
  }

  function handleCall(call: ts.CallExpression | ts.NewExpression, callee: Member): void {
    if (!isProjectNode(call)) return;
    if (ts.isNewExpression(call)) {
      if (callee.converts || callee.blocked) addFinding("constructor", call, undefined, callee);
      return;
    }
    if (callee.converts) {
      markAwaitSite(call, callee);
      return;
    }
    // Already async (or blocked): the caller reaches the database too.
    const context = enclosingContext(call);
    if (context.fn && !isExcludedNode(call)) {
      addCaller(callee, call, reach(context.fn, { kind: "calls", detail: callee.name, at: at(call) }, false));
    } else {
      addCaller(callee, call, undefined);
    }
    if (callee.alreadyAsync && !isAwaited(call)) {
      const outer = outerExpression(call);
      const parent = outer.parent;
      const valueUse = isBooleanContext(call) ||
        (!!parent && ts.isPropertyAccessExpression(parent) && parent.expression === outer && !/^(then|catch|finally)$/.test(parent.name.text));
      const dropped = !!parent && ts.isExpressionStatement(parent);
      if ((valueUse || dropped) && options.awaitUnawaited && !isExcludedNode(call)) {
        markAwaitSite(call, callee);
        addFinding("floating-async-call", call, `awaited a call whose promise was ${valueUse ? "used as a value" : "dropped"} (${callee.name})`, callee);
      } else if (valueUse) {
        addFinding("unawaited-async-call", call, `${RISK_DESCRIPTIONS["unawaited-async-call"]} (${callee.name})`, callee);
      } else if (dropped) {
        addFinding("floating-async-call", call, `${RISK_DESCRIPTIONS["floating-async-call"]} (${callee.name})`, callee);
      }
    }
  }

  function handleReference(reference: ts.Node, member: Member): void {
    if (!isProjectNode(reference) || !member.converts) return;
    const parent = outerExpression(reference).parent;
    if (parent && (ts.isJsxOpeningElement(parent) || ts.isJsxSelfClosingElement(parent))) {
      if (isClientFile(reference.getSourceFile())) addFinding("client-component", reference, undefined, member);
      return;
    }
    if (parent && ts.isVariableDeclaration(parent) && !parent.type) return; // an alias: its calls resolve to the member
    const classification = classifyFunctionUse(reference, member.node);
    if (classification.blocked) {
      addFinding(classification.blocked, reference, `${RISK_DESCRIPTIONS[classification.blocked]} (${member.name} passed as a value)`, member);
      return;
    }
    if (classification.signature) {
      reach(classification.signature, { kind: "receives-async-callback", detail: member.name, at: at(reference) }, true);
      if (classification.genericWrapper) {
        addFinding("generic-wrapper", reference, `${RISK_DESCRIPTIONS["generic-wrapper"]} (${classification.genericWrapper})`, member);
      }
    }
    if (classification.genericCall) {
      markAwaitSite(classification.genericCall, member);
      if (classification.genericWrapper) {
        addFinding("generic-wrapper", classification.genericCall, `${RISK_DESCRIPTIONS["generic-wrapper"]} (${classification.genericWrapper})`, member);
      }
    }
  }

  // ── Roots ──

  for (const site of dbSites.values()) {
    const call = site.node;
    if (site.kind === "transaction") {
      const callback = call.arguments[0];
      const fn = callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) ? callback : undefined;
      if (fn) transactionCallbacks.add(fn);
    }
  }

  for (const site of dbSites.values()) {
    const call = site.node;
    const kindLabel = site.kind === "transaction" ? "transaction" : site.kind.startsWith("raw-") ? "raw-sql" : "terminal";
    if (site.kind === "values") addFinding("values-terminal", call);
    if ((site.kind === "get" || site.kind === "all" || site.kind === "run") && call.arguments.length > 0) addFinding("prepared-statement", call);
    if (site.kind.startsWith("raw-")) addFinding("raw-sql-result", call);
    if (site.kind === "run" && site.resultUsed && !site.awaited) addFinding("run-result", call);
    if (site.kind === "transaction") {
      const callback = call.arguments[0];
      if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) {
        reach(callback, { kind: "transaction-callback", detail: "transaction()", at: at(call) }, site.sync);
      } else if (callback) {
        addFinding("function-value", callback, "transaction callback passed by reference: make it async and pass it directly");
      }
    }
    if (site.awaited) {
      const context = enclosingContext(call);
      if (context.fn) reach(context.fn, { kind: kindLabel, detail: `.${site.kind}()`, at: at(call) }, false);
      continue;
    }
    if (isExcludedNode(call)) continue;
    const context = enclosingContext(call);
    if (!context.fn) {
      addFinding(context.via === "class-field" ? "class-field" : "module-level", call);
      continue;
    }
    if (context.via === "parameter-default") addFinding("parameter-default", call);
    if (isBooleanContext(call)) addFinding("boolean-context", call);
    const member = reach(context.fn, { kind: kindLabel, detail: site.kind === "transaction" ? "transaction()" : `.${site.kind}()`, at: at(call) }, true);
    if (member.blocked) {
      addFinding(member.blocked, call, undefined, member);
      const classification = classifyFunction(context.fn);
      if (classification.passThrough) afterManualSite(classification.passThrough, member);
    }
  }

  for (const awaitExpression of awaitedBuilders) {
    if (isExcludedNode(awaitExpression)) continue;
    const context = enclosingContext(awaitExpression);
    if (context.fn) reach(context.fn, { kind: "awaits-builder", detail: "await builder", at: at(awaitExpression) }, false);
  }
  for (const call of dbLayerCalls) {
    if (isExcludedNode(call)) continue;
    const context = enclosingContext(call);
    if (context.fn) reach(context.fn, { kind: "db-helper", detail: `${calleeName(call.expression)}()`, at: at(call) }, false);
  }

  // Fixpoint: members are queued when found and again when they turn out to convert.
  for (let index = 0; index < queue.length; index++) process(queue[index]);

  // ── Findings that do not depend on the closure ──

  for (const sf of sourceFiles) {
    const fileRel = rel(sf);
    if (isExcluded(fileRel)) continue;
    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAccessExpression(node) && node.name.text === "$client") addFinding("raw-client", node);
      if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isRegularExpressionLiteral(node)) &&
        /SQLITE_[A-Z]|constraint failed/i.test(node.text)) {
        addFinding("driver-error", node);
      }
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === "drizzle-orm/sqlite-core") {
        const clause = node.importClause;
        const valueImports = clause && !clause.isTypeOnly && clause.namedBindings && ts.isNamedImports(clause.namedBindings)
          ? clause.namedBindings.elements.filter((e) => !e.isTypeOnly) : [];
        if (valueImports.length > 0 || (clause && !clause.isTypeOnly && clause.namedBindings && ts.isNamespaceImport(clause.namedBindings))) {
          addFinding("runtime-sqlite-core", node);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  // Awaits left inside functions that are not async (an earlier run's manual sites).
  for (const awaitExpression of nonAsyncAwaits) {
    if (isExcludedNode(awaitExpression)) continue;
    const context = enclosingContext(awaitExpression);
    if (!context.fn) continue;
    const member = members.get(context.fn);
    if (member?.converts) continue;
    const classification = classifyFunction(context.fn);
    addFinding("pending-manual", awaitExpression, `${RISK_DESCRIPTIONS["pending-manual"]}${classification.blocked ? ` (${classification.blocked})` : ""}`);
  }

  // ── Derived facts: transactions, reads and writes, recursion, check-then-act ──

  for (const member of members.values()) {
    member.inTransaction = isInsideTransactionCallback(member.node) || takesTransaction(member.node);
  }
  // Called only from transactions.
  const callersOf = new Map<Member, Member[]>();
  for (const member of members.values()) {
    for (const caller of member.callers) {
      if (!caller.member) continue;
      const list = callersOf.get(member) ?? [];
      list.push(caller.member);
      callersOf.set(member, list);
    }
  }
  let changedTx = true;
  while (changedTx) {
    changedTx = false;
    for (const member of members.values()) {
      if (member.inTransaction) continue;
      const callers = callersOf.get(member);
      if (callers && callers.length > 0 && member.callers.every((c) => c.member?.inTransaction)) {
        member.inTransaction = true;
        changedTx = true;
      }
    }
  }

  function takesTransaction(node: ts.SignatureDeclaration): boolean {
    return node.parameters.some((parameter) => {
      const type = checker.getTypeAtLocation(parameter);
      const name = (type.getSymbol() ?? type.aliasSymbol)?.getName() ?? "";
      return /SQLiteTransaction/.test(name) || checker.getPropertyOfType(type, "rollback") !== undefined;
    });
  }
  computeReadWrite();
  findRecursion();
  findCheckThenAct();

  function computeReadWrite(): void {
    for (const site of dbSites.values()) {
      const context = enclosingContext(site.node);
      const member = context.fn ? members.get(context.fn) : undefined;
      if (!member) continue;
      if (site.receiver === "select" || site.receiver === "query" || site.kind === "raw-all" || site.kind === "raw-get") member.reads = true;
      else member.writes = true;
    }
    for (const awaitExpression of awaitedBuilders) {
      const context = enclosingContext(awaitExpression);
      const member = context.fn ? members.get(context.fn) : undefined;
      if (!member) continue;
      const text = awaitExpression.expression.getText();
      if (/\.(insert|update|delete)\s*\(/.test(text)) member.writes = true;
      else member.reads = true;
    }
    let changedFlags = true;
    while (changedFlags) {
      changedFlags = false;
      for (const member of members.values()) {
        for (const caller of member.callers) {
          const callerMember = caller.member;
          if (!callerMember) continue;
          if (member.reads && !callerMember.reads) {
            callerMember.reads = true;
            changedFlags = true;
          }
          if (member.writes && !callerMember.writes) {
            callerMember.writes = true;
            changedFlags = true;
          }
        }
      }
    }
  }

  function findRecursion(): void {
    // Tarjan's strongly connected components over converting members.
    const graph = new Map<Member, Set<Member>>();
    for (const member of members.values()) {
      if (!member.converts) continue;
      for (const caller of member.callers) {
        if (!caller.member?.converts) continue;
        const edges = graph.get(caller.member) ?? new Set<Member>();
        edges.add(member);
        graph.set(caller.member, edges);
      }
    }
    let index = 0;
    const indices = new Map<Member, number>();
    const lowlinks = new Map<Member, number>();
    const stack: Member[] = [];
    const onStack = new Set<Member>();
    const strongConnect = (member: Member) => {
      indices.set(member, index);
      lowlinks.set(member, index);
      index++;
      stack.push(member);
      onStack.add(member);
      for (const next of graph.get(member) ?? []) {
        if (!indices.has(next)) {
          strongConnect(next);
          lowlinks.set(member, Math.min(lowlinks.get(member)!, lowlinks.get(next)!));
        } else if (onStack.has(next)) {
          lowlinks.set(member, Math.min(lowlinks.get(member)!, indices.get(next)!));
        }
      }
      if (lowlinks.get(member) === indices.get(member)) {
        const component: Member[] = [];
        let next: Member;
        do {
          next = stack.pop()!;
          onStack.delete(next);
          component.push(next);
        } while (next !== member);
        const selfLoop = component.length === 1 && (graph.get(member)?.has(member) ?? false);
        if (component.length > 1 || selfLoop) {
          for (const item of component) {
            addFinding("recursion", item.node, `${RISK_DESCRIPTIONS.recursion} (${component.map((c) => c.name).join(" → ")})`, item);
          }
        }
      }
    };
    for (const member of graph.keys()) if (!indices.has(member)) strongConnect(member);
  }

  function findCheckThenAct(): void {
    for (const member of members.values()) {
      if (!member.converts || member.inTransaction || !isFunctionWithBody(member.node)) continue;
      // The database operations in the member's own body, in source order.
      const operations: Array<{ pos: number; reads: boolean; writes: boolean }> = [];
      const fn = member.node;
      const visit = (node: ts.Node) => {
        if (node !== fn && isFunctionWithBody(node)) {
          if (transactionCallbacks.has(node)) operations.push({ pos: node.pos, reads: false, writes: true });
          return;
        }
        if (ts.isCallExpression(node)) {
          const site = dbSites.get(node);
          if (site && site.kind !== "transaction") {
            const reads = site.receiver === "select" || site.receiver === "query" || site.kind === "raw-all" || site.kind === "raw-get";
            operations.push({ pos: node.pos, reads, writes: !reads });
          }
          const awaitSite = awaitSites.get(node);
          if (awaitSite && !site) operations.push({ pos: node.pos, reads: awaitSite.target.reads, writes: awaitSite.target.writes });
        }
        ts.forEachChild(node, visit);
      };
      if (fn.body) visit(fn.body);
      operations.sort((a, b) => a.pos - b.pos);
      const firstRead = operations.findIndex((op) => op.reads);
      if (firstRead >= 0 && operations.slice(firstRead + 1).some((op) => op.writes)) {
        addFinding("check-then-act", fn, undefined, member);
      }
    }
  }

  // Await sites and converted members add files; findings in files with nothing else do too.
  for (const finding of findings) if (finding.manual && !isExcluded(finding.file)) files.add(finding.file);

  return { program, checker, root, members, dbSites, awaitSites, findings, syncDbSymbol, files };
}
