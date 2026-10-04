// SPDX-License-Identifier: Elastic-2.0
/**
 * Differences between two configurations, per entity type: items added,
 * removed and changed, with field-level changes. Secrets are never shown:
 * secret columns, encrypted values and fields whose name marks them as
 * secret only report that they changed.
 */
import { isEncryptedSecret } from "@/src/lib/secret";
import {
  CONFIG_SETTING_KEYS,
  CONFIG_SETTING_LABELS,
  CONFIG_TABLE_NAMES,
  CONFIG_TABLES,
  countConfigContent,
  type ConfigContent,
  type ConfigRow,
  type ConfigSettingKey,
  type ConfigTableName,
} from "@/src/lib/config-content";
import { canonicalJson, secretDigest, VOLATILE_COLUMNS } from "./fingerprint";

export type FieldChange = {
  /** Column name, or a dotted path into a JSON column or a settings group. */
  path: string;
  before?: unknown;
  after?: unknown;
  /** The value is secret: only the fact that it changed is reported. */
  secret?: true;
};

export type DiffItem = { id: number | string; label: string };
export type ChangedItem = DiffItem & { changes: FieldChange[] };

export type DiffEntity = ConfigTableName | "settings";

export type EntityDiff = {
  entity: DiffEntity;
  label: string;
  added: DiffItem[];
  removed: DiffItem[];
  changed: ChangedItem[];
};

export type ConfigDiff = {
  /** Only entity types with at least one difference, in a stable order. */
  entities: EntityDiff[];
  totals: { added: number; removed: number; changed: number };
};

const SENSITIVE_NAME = /passw(or)?d|passphrase|secret|token|private_?key|api_?key|credential|cookie/i;
const MASK_ALL_SETTINGS: ReadonlySet<ConfigSettingKey> = new Set(["cloudflare"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function lastSegment(path: string): string {
  const parts = path.split(".");
  return parts[parts.length - 1] ?? path;
}

function containsSecret(value: unknown): boolean {
  if (typeof value === "string") return isEncryptedSecret(value);
  if (Array.isArray(value)) return value.some(containsSecret);
  if (isRecord(value)) return Object.entries(value).some(([key, item]) => SENSITIVE_NAME.test(key) || containsSecret(item));
  return false;
}

/** Secrets replaced by digests of their plaintext, for comparison only. */
function comparable(value: unknown): unknown {
  if (typeof value === "string") return isEncryptedSecret(value) ? secretDigest(value) : value;
  if (Array.isArray(value)) return value.map(comparable);
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, comparable(item)]));
  return value;
}

function sameValue(a: unknown, b: unknown): boolean {
  return canonicalJson(comparable(a ?? null)) === canonicalJson(comparable(b ?? null));
}

function parseJsonText(value: unknown): unknown {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

/** Field-level differences between two JSON values; objects are compared key by key. */
function diffJson(before: unknown, after: unknown, path: string, out: FieldChange[], maskAll = false): void {
  // An object that appears or disappears is listed field by field, so that
  // secret fields inside it stay masked.
  if ((isRecord(before) || isRecord(after)) && (isRecord(before) || before == null) && (isRecord(after) || after == null)) {
    const a = isRecord(before) ? before : {};
    const b = isRecord(after) ? after : {};
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    for (const key of keys) {
      diffJson(a[key], b[key], path ? `${path}.${key}` : key, out, maskAll);
    }
    return;
  }
  if (sameValue(before, after)) return;
  if (maskAll || SENSITIVE_NAME.test(lastSegment(path)) || containsSecret(before) || containsSecret(after)) {
    out.push({ path, secret: true });
    return;
  }
  out.push({ path, before: before === undefined ? null : before, after: after === undefined ? null : after });
}

function diffRow(name: ConfigTableName, before: ConfigRow, after: ConfigRow): FieldChange[] {
  const secretColumns: Record<string, unknown> = CONFIG_TABLES[name].secretColumns;
  const columns = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((column) => !VOLATILE_COLUMNS.has(column))
    .sort();
  const changes: FieldChange[] = [];
  for (const column of columns) {
    const a = before[column];
    const b = after[column];
    if (column in secretColumns) {
      if (!sameValue(a, b)) changes.push({ path: column, secret: true });
      continue;
    }
    // JSON text columns (meta, domains, upstreams, ...) are compared as JSON.
    const parsedA = a == null ? null : parseJsonText(a);
    const parsedB = b == null ? null : parseJsonText(b);
    if (parsedA !== undefined && parsedB !== undefined) {
      diffJson(parsedA, parsedB, column, changes);
      continue;
    }
    diffJson(a, b, column, changes);
  }
  return changes;
}

/**
 * Field-level differences of one row; a missing side is an empty row, so an
 * added or removed row lists every field it has (secrets masked, the id and
 * timestamps left out).
 */
export function rowFieldChanges(name: ConfigTableName, before: ConfigRow | null, after: ConfigRow | null): FieldChange[] {
  const changes = diffRow(name, before ?? {}, after ?? {});
  return before && after ? changes : changes.filter((change) => change.path !== "id");
}

export function rowLabel(name: ConfigTableName, row: ConfigRow): string {
  const label = CONFIG_TABLES[name].describe(row).trim();
  return label || `#${String(row.id)}`;
}

function diffTable(name: ConfigTableName, fromRows: ConfigRow[], toRows: ConfigRow[]): EntityDiff {
  const fromById = new Map(fromRows.map((row) => [row.id as number, row]));
  const toById = new Map(toRows.map((row) => [row.id as number, row]));
  const result: EntityDiff = { entity: name, label: CONFIG_TABLES[name].plural, added: [], removed: [], changed: [] };
  for (const [id, row] of toById) {
    const previous = fromById.get(id);
    if (!previous) {
      result.added.push({ id, label: rowLabel(name, row) });
      continue;
    }
    const changes = diffRow(name, previous, row);
    if (changes.length > 0) result.changed.push({ id, label: rowLabel(name, row), changes });
  }
  for (const [id, row] of fromById) {
    if (!toById.has(id)) result.removed.push({ id, label: rowLabel(name, row) });
  }
  return result;
}

function diffSettings(from: ConfigContent["settings"], to: ConfigContent["settings"]): EntityDiff {
  const result: EntityDiff = { entity: "settings", label: "Settings", added: [], removed: [], changed: [] };
  for (const key of CONFIG_SETTING_KEYS) {
    const before = from[key] ?? null;
    const after = to[key] ?? null;
    const item = { id: key, label: CONFIG_SETTING_LABELS[key] };
    if (before === null && after === null) continue;
    if (before === null) {
      result.added.push(item);
      continue;
    }
    if (after === null) {
      result.removed.push(item);
      continue;
    }
    const changes: FieldChange[] = [];
    diffJson(before, after, "", changes, MASK_ALL_SETTINGS.has(key));
    if (changes.length > 0) result.changed.push({ ...item, changes });
  }
  return result;
}

/** Field-level differences of one settings group (null: not set); secrets masked. */
export function settingFieldChanges(key: ConfigSettingKey, before: unknown, after: unknown): FieldChange[] {
  const changes: FieldChange[] = [];
  diffJson(before ?? null, after ?? null, "", changes, MASK_ALL_SETTINGS.has(key));
  return changes;
}

/** What changes when the configuration goes from `from` to `to`. */
export function diffConfigContent(from: ConfigContent, to: ConfigContent): ConfigDiff {
  const entities = [
    ...CONFIG_TABLE_NAMES.map((name) => diffTable(name, from.tables[name], to.tables[name])),
    diffSettings(from.settings, to.settings),
  ].filter((entity) => entity.added.length + entity.removed.length + entity.changed.length > 0);
  const totals = entities.reduce(
    (sum, entity) => ({
      added: sum.added + entity.added.length,
      removed: sum.removed + entity.removed.length,
      changed: sum.changed + entity.changed.length,
    }),
    { added: 0, removed: 0, changed: 0 }
  );
  return { entities, totals };
}

const MAX_SUMMARY_LENGTH = 500;

function truncate(text: string): string {
  return text.length > MAX_SUMMARY_LENGTH ? `${text.slice(0, MAX_SUMMARY_LENGTH - 1)}…` : text;
}

function describeItems(verb: string, items: DiffItem[]): string | null {
  if (items.length === 0) return null;
  if (items.length === 1) return `${verb} “${items[0].label}”`;
  return `${items.length} ${verb}`;
}

/** One line describing a diff, e.g. "Proxy hosts: changed “app”; Settings: 2 changed". */
export function summarizeDiff(diff: ConfigDiff): string {
  if (diff.entities.length === 0) return "No changes";
  return truncate(
    diff.entities
      .map((entity) => {
        const parts = [
          describeItems("added", entity.added),
          describeItems("removed", entity.removed),
          describeItems("changed", entity.changed),
        ].filter(Boolean);
        return `${entity.label}: ${parts.join(", ")}`;
      })
      .join("; ")
  );
}

/** One line describing a whole configuration, e.g. for the first snapshot. */
export function describeConfigContent(content: ConfigContent): string {
  const counts = countConfigContent(content);
  const parts = CONFIG_TABLE_NAMES.filter((name) => counts[name] > 0).map(
    (name) => `${counts[name]} ${counts[name] === 1 ? CONFIG_TABLES[name].singular : CONFIG_TABLES[name].plural.toLowerCase()}`
  );
  if (counts.settings > 0) parts.push(`${counts.settings} settings group${counts.settings === 1 ? "" : "s"}`);
  return truncate(parts.length > 0 ? parts.join(", ") : "Empty configuration");
}

export type ContentSummary = {
  counts: ReturnType<typeof countConfigContent>;
  items: Partial<Record<ConfigTableName, DiffItem[]>>;
  settings: ConfigSettingKey[];
};

/** What a configuration contains, by name, without any values. */
export function summarizeConfigContent(content: ConfigContent): ContentSummary {
  const items: Partial<Record<ConfigTableName, DiffItem[]>> = {};
  for (const name of CONFIG_TABLE_NAMES) {
    if (content.tables[name].length > 0) {
      items[name] = content.tables[name].map((row) => ({ id: row.id as number, label: rowLabel(name, row) }));
    }
  }
  return {
    counts: countConfigContent(content),
    items,
    settings: CONFIG_SETTING_KEYS.filter((key) => content.settings[key] !== null && content.settings[key] !== undefined),
  };
}
