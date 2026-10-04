/**
 * Dates as ISO 8601 text for a Kysely instance on PostgreSQL (D5): the
 * schema stores every date as text written by nowIso()
 * (2026-01-01T00:00:00.000Z), on PostgreSQL as on SQLite, while a library
 * that runs its own queries through Kysely on PostgreSQL (Better Auth,
 * src/lib/db/auth-database.ts) writes Date objects and expects Date objects
 * back.
 *
 * - Every Date parameter of a query (values, comparisons, raw SQL) is sent
 *   as `date.toISOString()`, so stored dates keep one format and compare as
 *   text in the order they compare as dates. node-postgres would otherwise
 *   send a Date in the server's local time with an offset
 *   (2026-01-01T01:00:00.000+01:00), which sorts differently.
 * - In the rows a query returns, the date columns of the table it reads,
 *   inserts into, updates or deletes from, and of the tables it joins
 *   (`_joined_<table>_<column>`, how Better Auth names joined columns), are
 *   turned back into Dates. Text is read with `new Date(text)`, as Better
 *   Auth reads dates stored as text on SQLite. Other columns, and queries on
 *   other tables, are left alone.
 */
import {
  AliasNode,
  DeleteQueryNode,
  InsertQueryNode,
  OperationNodeTransformer,
  PrimitiveValueListNode,
  SelectQueryNode,
  TableNode,
  UpdateQueryNode,
  ValueNode,
  type KyselyPlugin,
  type OperationNode,
  type PluginTransformQueryArgs,
  type PluginTransformResultArgs,
  type QueryId,
  type QueryResult,
  type RootOperationNode,
  type UnknownRow,
} from "kysely";

/** The columns holding dates, by table name. */
export type DateColumns = ReadonlyMap<string, ReadonlySet<string>>;

/** A Date as the text the schema stores; anything else unchanged. */
function toStoredValue(value: unknown): unknown {
  // toISOString() throws on an invalid Date, as Better Auth's own
  // conversion on SQLite does: an invalid date is never written.
  return value instanceof Date ? value.toISOString() : value;
}

/** Replaces the Date parameters of a query with ISO 8601 text. */
class DateParameterTransformer extends OperationNodeTransformer {
  protected override transformValue(node: ValueNode, queryId?: QueryId): ValueNode {
    const value = super.transformValue(node, queryId);
    if (!(value.value instanceof Date)) return value;
    const text = toStoredValue(value.value);
    return value.immediate ? ValueNode.createImmediate(text) : ValueNode.create(text);
  }

  protected override transformPrimitiveValueList(node: PrimitiveValueListNode, queryId?: QueryId): PrimitiveValueListNode {
    const list = super.transformPrimitiveValueList(node, queryId);
    if (!list.values.some((value) => value instanceof Date)) return list;
    return PrimitiveValueListNode.create(list.values.map(toStoredValue));
  }
}

/** The table a FROM item, join target or query target names (through aliases and derived tables). */
function tableOf(node: OperationNode | undefined): string | undefined {
  if (!node) return undefined;
  if (TableNode.is(node)) return node.table.identifier.name;
  if (AliasNode.is(node)) return tableOf(node.node);
  if (SelectQueryNode.is(node)) return tableOf(node.from?.froms[0]);
  return undefined;
}

/** The table whose rows a query returns: the one it reads, inserts into, updates or deletes from. */
function targetTable(node: RootOperationNode): string | undefined {
  if (SelectQueryNode.is(node)) return tableOf(node.from?.froms[0]);
  if (InsertQueryNode.is(node)) return tableOf(node.into);
  if (UpdateQueryNode.is(node)) return tableOf(node.table);
  if (DeleteQueryNode.is(node)) return tableOf(node.from.froms[0]);
  return undefined;
}

/**
 * The Kysely plugin (see the module comment). `dateColumns` lists, for each
 * table, the columns whose values are dates to the code issuing the queries.
 */
export class IsoDatesPlugin implements KyselyPlugin {
  readonly #parameters = new DateParameterTransformer();
  /** The result columns to read back as dates, per query (Kysely's documented pattern for per-query plugin state). */
  readonly #dateKeys = new WeakMap<QueryId, ReadonlySet<string>>();

  constructor(private readonly dateColumns: DateColumns) {}

  transformQuery({ node, queryId }: PluginTransformQueryArgs): RootOperationNode {
    const keys = new Set<string>();
    const target = targetTable(node);
    for (const column of (target && this.dateColumns.get(target)) || []) keys.add(column);
    if (SelectQueryNode.is(node)) {
      for (const join of node.joins ?? []) {
        const joined = tableOf(join.table);
        for (const column of (joined && this.dateColumns.get(joined)) || []) keys.add(`_joined_${joined}_${column}`);
      }
    }
    if (keys.size > 0) this.#dateKeys.set(queryId, keys);
    return this.#parameters.transformNode(node, queryId);
  }

  async transformResult({ result, queryId }: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
    const keys = this.#dateKeys.get(queryId);
    if (!keys || !result.rows || result.rows.length === 0) return result;
    return { ...result, rows: result.rows.map((row) => withDates(row, keys)) };
  }
}

/** `row` with the text in `keys` read as dates (a copy when anything changes). */
function withDates(row: UnknownRow, keys: ReadonlySet<string>): UnknownRow {
  let converted: Record<string, unknown> | null = null;
  for (const key of keys) {
    const value = row[key];
    if (typeof value !== "string") continue;
    converted ??= { ...row };
    converted[key] = new Date(value);
  }
  return converted ?? row;
}
