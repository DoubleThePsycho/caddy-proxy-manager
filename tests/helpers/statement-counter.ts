/**
 * Counts the statements a test database runs, on SQLite and PostgreSQL alike
 * (tests/helpers/db.ts): on SQLite every statement, transaction control
 * included, goes through the executor's statement runner; on PostgreSQL a
 * statement outside a transaction goes through the executor's pool, and a
 * transaction starts by taking a connection from it (counted as one entry,
 * "(a transaction)", for the transaction and its statements).
 *
 *   const counter = countStatements(db);
 *   await somethingThatShouldNotQuery();
 *   expect(counter.statements).toEqual([]);
 *   counter.stop();
 */
import { PostgresExecutor, resolveDbTarget, SqliteExecutor } from '../../src/lib/db/executor';
import type { AppDb } from '../../src/lib/db/types';

export type StatementCounter = {
  /** The SQL of every statement run since the counter started, in order. */
  readonly statements: readonly string[];
  /** Puts the database back as it was. */
  stop(): void;
};

type Method = (...args: unknown[]) => unknown;

/** Replaces `object[name]` with a wrapper that records each call first; returns the undo. */
function wrap(object: object, name: string, record: (args: unknown[]) => void): () => void {
  const target = object as Record<string, unknown>;
  const original = target[name] as Method;
  const own = Object.prototype.hasOwnProperty.call(target, name);
  target[name] = function (this: unknown, ...args: unknown[]) {
    record(args);
    return original.apply(this, args);
  };
  return () => {
    if (own) target[name] = original;
    else delete target[name];
  };
}

function sqlOf(value: unknown): string {
  if (typeof value === 'string') return value;
  const text = (value as { text?: unknown } | null)?.text;
  return typeof text === 'string' ? text : String(value);
}

export function countStatements(db: AppDb): StatementCounter {
  const statements: string[] = [];
  const undo: Array<() => void> = [];
  const { executor } = resolveDbTarget(db);
  if (executor instanceof SqliteExecutor) {
    for (const name of ['values', 'firstValues', 'query', 'run', 'exec']) {
      undo.push(wrap(executor.runner, name, (args) => statements.push(sqlOf(args[0]))));
    }
  } else if (executor instanceof PostgresExecutor) {
    undo.push(wrap(executor.pool, 'query', (args) => statements.push(sqlOf(args[0]))));
    undo.push(wrap(executor.pool, 'connect', () => statements.push('(a transaction)')));
  } else {
    throw new Error('countStatements needs a database facade from tests/helpers/db.ts');
  }
  return {
    get statements() {
      return statements;
    },
    stop() {
      for (const restore of undo.reverse()) restore();
    },
  };
}
