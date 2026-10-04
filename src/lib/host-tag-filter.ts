import { type SQL } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { jsonArrayIncludesAny, sqlFalse } from "@/src/lib/db/ops";

/**
 * SQL condition: the JSON tag array in `column` holds at least one of `tags`.
 * With no tags it matches nothing, so an empty scope never widens a query.
 */
export function tagsMatchAny(column: SQLiteColumn, tags: readonly string[]): SQL {
  if (tags.length === 0) return sqlFalse();
  return jsonArrayIncludesAny(column, tags);
}
