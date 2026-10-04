/**
 * src/lib/db/schema.ts and schema.pg.ts are generated from schema.sqlite.ts
 * by scripts/db/generate-pg-schema.ts; every integer column is classified
 * int4 or int8 for PostgreSQL in src/lib/db/pg-column-types.ts.
 */
import { describe, expect, it } from 'vitest';
import { is } from 'drizzle-orm';
import { SQLiteTable, getTableConfig } from 'drizzle-orm/sqlite-core';
import * as sqliteSchema from '../../src/lib/db/schema.sqlite';
import * as schema from '../../src/lib/db/schema';
import { PG_INTEGER_COLUMNS } from '../../src/lib/db/pg-column-types';
import {
  readSchemaExports,
  renderSwitch,
  staleSchemaFiles,
  transformToPg,
} from '../../scripts/db/generate-pg-schema';

const sqliteTables = (Object.values(sqliteSchema) as unknown[]).filter((value): value is SQLiteTable =>
  is(value, SQLiteTable)
);

const HEADER = 'import { sql } from "drizzle-orm";\nimport { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";\n';

describe('generated schema files', () => {
  it('are up to date (bun run db:check-pg-schema)', () => {
    expect(staleSchemaFiles()).toEqual([]);
  });

  it('schema.ts exports every table of schema.sqlite.ts as the same object', () => {
    expect(Object.keys(schema).sort()).toEqual(Object.keys(sqliteSchema).sort());
    for (const [name, table] of Object.entries(sqliteSchema)) {
      expect((schema as Record<string, unknown>)[name], name).toBe(table);
    }
  });
});

describe('pg-column-types.ts', () => {
  const integerColumns = sqliteTables.flatMap((table) => {
    const { name, columns } = getTableConfig(table);
    return columns.filter((column) => column.columnType === 'SQLiteInteger').map((column) => `${name}.${column.name}`);
  });

  it('classifies every integer column of schema.sqlite.ts, and nothing else', () => {
    const classified = Object.entries(PG_INTEGER_COLUMNS).flatMap(([table, columns]) =>
      Object.keys(columns).map((column) => `${table}.${column}`)
    );
    expect(classified.sort()).toEqual([...integerColumns].sort());
    // 303 integer columns, 57 of them booleans.
    expect(integerColumns.length).toBeGreaterThanOrEqual(246);
  });

  it('makes money, byte sizes, sequences and growing counters int8', () => {
    const int8 = Object.entries(PG_INTEGER_COLUMNS)
      .flatMap(([table, columns]) => Object.entries(columns).filter(([, width]) => width === 'int8').map(([column]) => `${table}.${column}`))
      .sort();
    expect(int8).toEqual([
      'auth_rate_limits.id',
      'auth_rate_limits.lastRequest',
      'backup_runs.sizeBytes',
      'compliance_reports.sizeBytes',
      'config_snapshots.sizeBytes',
      'fleet_revisions.sizeBytes',
      'monetization_answer_credits.amountMicros',
      'monetization_consumers.balanceMicros',
      'monetization_consumers.overdraftAllowanceMicros',
      'monetization_ledger.amountMicros',
      'monetization_ledger.balanceAfterMicros',
      'monetization_ledger.freeRequests',
      'monetization_ledger.requests',
      'monetization_payments.amountMicros',
      'monetization_payments.disputedMicros',
      'monetization_payments.refundedMicros',
      'monetization_plans.postpaidCapMicros',
      'monetization_plans.postpaidThresholdMicros',
      'monetization_plans.pricePerRequestMicros',
      'monetization_shared_cursors.chargedMicros',
      'monetization_shared_cursors.freeRequests',
      'monetization_shared_cursors.requests',
      'monetization_x402_payments.amountMicros',
      'passkeys.counter',
      'rate_limit_counters.blockedUntilMs',
      'rate_limit_counters.expiresAtMs',
      'rate_limit_counters.heldUntilMs',
      'rate_limit_counters.windowStartMs',
      'virtual_patches.feedSequence',
    ]);
    // Every *Micros and sizeBytes column, present and future.
    for (const column of integerColumns.filter((name) => /Micros$|\.sizeBytes$/.test(name))) {
      expect(int8, column).toContain(column);
    }
  });
});

describe('generate-pg-schema transform', () => {
  it('translates column types, keys, references and ifnull, keeping comments', () => {
    const source = `${HEADER}
/** Things. */
export const things = sqliteTable(
  "things",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    // The owner.
    ownerId: integer("ownerId")
      .references(() => owners.id, { onDelete: "cascade" })
      .notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    sizeBytes: integer("sizeBytes").notNull(),
    code: text("code", { length: 50 }),
    organizationId: integer("organizationId")
  },
  (table) => ({
    nameUnique: uniqueIndex("things_unique").on(sql\`ifnull(\${table.organizationId}, 0)\`, table.code),
    ownerIdx: index("things_owner_idx").on(table.ownerId)
  })
);

export const owners = sqliteTable("owners", {
  id: integer("id").primaryKey()
});
`;
    const classification = {
      things: { id: 'int4', ownerId: 'int4', sizeBytes: 'int8', organizationId: 'int4' },
      owners: { id: 'int4' },
    } as const;
    expect(transformToPg(source, classification)).toBe(`import { sql } from "drizzle-orm";
import { bigint, boolean, index, integer, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";

/** Things. */
export const things = pgTable(
  "things",
  {
    id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
    // The owner.
    ownerId: integer("ownerId")
      .notNull(),
    enabled: boolean("enabled").notNull().default(true),
    sizeBytes: bigint("sizeBytes", { mode: "number" }).notNull(),
    code: text("code"),
    organizationId: integer("organizationId")
  },
  (table) => ({
    nameUnique: uniqueIndex("things_unique").on(sql\`coalesce(\${table.organizationId}, 0)\`, table.code),
    ownerIdx: index("things_owner_idx").on(table.ownerId)
  })
);

export const owners = pgTable("owners", {
  id: integer("id").primaryKey()
});
`);
  });

  it('is deterministic', () => {
    const source = `${HEADER}export const a = sqliteTable("a", { id: integer("id").primaryKey({ autoIncrement: true }) });\n`;
    const classification = { a: { id: 'int4' } } as const;
    expect(transformToPg(source, classification)).toBe(transformToPg(source, classification));
  });

  it('refuses an integer column that is not classified', () => {
    const source = `${HEADER}export const a = sqliteTable("a", { count: integer("count") });\n`;
    expect(() => transformToPg(source, {})).toThrow(/pg-column-types\.ts[\s\S]*a\.count/);
  });

  it('refuses a classification for a column that is not an integer column', () => {
    const source = `${HEADER}export const a = sqliteTable("a", { flag: integer("flag", { mode: "boolean" }) });\n`;
    expect(() => transformToPg(source, { a: { flag: 'int4' } })).toThrow(/not integer columns[\s\S]*a\.flag/);
  });

  it('refuses constructs it has no translation for', () => {
    expect(() =>
      transformToPg('import { real, sqliteTable } from "drizzle-orm/sqlite-core";\nexport const a = sqliteTable("a", { r: real("r") });\n', {})
    ).toThrow(/"real"/);
    expect(() =>
      transformToPg(`${HEADER}export const a = sqliteTable("a", { at: integer("at", { mode: "timestamp" }) });\n`, {})
    ).toThrow(/mode "timestamp"/);
    expect(() =>
      transformToPg(
        `${HEADER}export const a = sqliteTable("a", { v: text("v") }, (t) => ({ i: index("a_i").on(sql\`json_extract(\${t.v}, '$.x')\`) }));\n`,
        {}
      )
    ).toThrow(/json_extract/);
  });

  it('renders the switch from the exports of schema.sqlite.ts', () => {
    const source = `${HEADER}export const a = sqliteTable("a", { v: text("v") });\nexport const b = sqliteTable("b", { v: text("v") });\nexport type A = typeof a.$inferSelect;\n`;
    const exports = readSchemaExports(source);
    expect(exports).toEqual({ tables: [{ exportName: 'a', tableName: 'a' }, { exportName: 'b', tableName: 'b' }], types: ['A'] });
    const rendered = renderSwitch(exports);
    expect(rendered).toContain('import * as sqliteSchema from "./schema.sqlite";');
    expect(rendered).toContain('import * as pgSchema from "./schema.pg";');
    expect(rendered).toContain('export const a = tables.a;\nexport const b = tables.b;\n');
    expect(rendered).toContain('export type { A } from "./schema.sqlite";');
    expect(() => readSchemaExports(`${HEADER}export const helper = 1;\n`)).toThrow(/only tables/);
  });

  it('renders the switch that picks the PostgreSQL tables at module load, or SQLite only on request', () => {
    const exports = { tables: [{ exportName: 'a', tableName: 'a' }], types: [] };
    const rendered = renderSwitch(exports);
    expect(rendered).toContain('import { getDialect } from "./dialect";');
    expect(rendered).toContain(
      'const tables = (getDialect() === "postgres" ? pgSchema : sqliteSchema) as unknown as typeof sqliteSchema;'
    );
    expect(rendered).toContain('export const a = tables.a;\n');
    const sqliteOnly = renderSwitch(exports, { withPostgres: false });
    expect(sqliteOnly).toContain('const tables: typeof sqliteSchema = sqliteSchema;');
    expect(sqliteOnly).not.toContain('import * as pgSchema');
  });
});
