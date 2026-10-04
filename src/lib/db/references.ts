import { getTableColumns, is } from "drizzle-orm";
import { SQLiteTable, getTableConfig, type SQLiteColumn } from "drizzle-orm/sqlite-core";
import * as authoring from "./schema.sqlite";
import * as schema from "./schema";

/** A column that schema.sqlite.ts declares as a reference to another table. */
export type TableReference = {
  /** The referencing table and column, as the application queries them (`./schema`). */
  table: SQLiteTable;
  column: SQLiteColumn;
  /** Their names in the database. */
  tableName: string;
  columnName: string;
  /** The declared action; foreign keys are not enforced, so code has to carry it out. */
  onDelete: string;
};

const cache = new Map<string, readonly TableReference[]>();

/**
 * Every column that references `tableName` (its name in the database), in
 * schema order. The references are read from the authoring metadata in
 * schema.sqlite.ts, the only place they are declared (schema.pg.ts has
 * none), and handed out as the tables and columns of the dialect the process
 * runs on.
 */
export function referencesTo(tableName: string): readonly TableReference[] {
  const cached = cache.get(tableName);
  if (cached) return cached;
  const runtime = schema as unknown as Record<string, SQLiteTable>;
  const references: TableReference[] = [];
  for (const [exportName, value] of Object.entries(authoring)) {
    if (!is(value, SQLiteTable)) continue;
    const config = getTableConfig(value);
    for (const foreignKey of config.foreignKeys) {
      const reference = foreignKey.reference();
      if (getTableConfig(reference.foreignTable).name !== tableName) continue;
      if (reference.columns.length !== 1) {
        throw new Error(`${config.name}: a reference over several columns is not supported by referencesTo()`);
      }
      const [authoredColumn] = reference.columns;
      const columnKey = Object.entries(getTableColumns(value)).find(([, column]) => column === authoredColumn)?.[0];
      const table = runtime[exportName];
      const column = columnKey && table ? (getTableColumns(table) as Record<string, SQLiteColumn>)[columnKey] : undefined;
      if (!column) throw new Error(`${config.name}.${authoredColumn.name} is missing from the runtime schema`);
      references.push({
        table,
        column,
        tableName: config.name,
        columnName: authoredColumn.name,
        onDelete: foreignKey.onDelete ?? "no action",
      });
    }
  }
  cache.set(tableName, references);
  return references;
}
