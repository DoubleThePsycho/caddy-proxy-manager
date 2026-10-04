"use client";

import { Fragment, useMemo, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { diffJson, foldContext, hasChanges, toSplitRows, type DiffLine, type DiffSegment } from "@/components/ui/diff";

export type { DiffLine } from "@/components/ui/diff";

export type DiffMode = "unified" | "split";

/** One changed field (configuration history, change requests): its path and the values on each side. */
export type DiffField = {
  /** Column name or dotted path, e.g. "upstreams.0". */
  path: string;
  /** undefined or null: the field was not set before. */
  before?: unknown;
  /** undefined or null: the field is not set after. */
  after?: unknown;
  /** The value is secret: only the fact that it changed is shown. */
  secret?: boolean;
};

export type DiffViewProps = {
  /** A ready-made line diff (diffLines/diffJson from @/components/ui/diff, or the server's). */
  lines?: readonly DiffLine[];
  /** Field-by-field changes; takes precedence over `lines` and `before`/`after`. */
  fields?: readonly DiffField[];
  /** Two JSON values to compare (key order ignored), used when neither `lines` nor `fields` is given. */
  before?: unknown;
  after?: unknown;
  /** Controlled layout. */
  mode?: DiffMode;
  /** Initial layout when uncontrolled. Default "unified". */
  defaultMode?: DiffMode;
  onModeChange?: (mode: DiffMode) => void;
  /** Shows the Unified / Side by side switch in the header bar. */
  showModeToggle?: boolean;
  /** Header bar content, e.g. "Proxy hosts › app.example.com". */
  title?: ReactNode;
  /** Column headings of the side-by-side layout. Default "Before" and "After". */
  beforeLabel?: string;
  afterLabel?: string;
  /** Unchanged lines kept around each change before the rest folds. Default 3. */
  context?: number;
  /** Shown when nothing changed. Default "No changes". */
  emptyText?: ReactNode;
  /** Caption for screen readers. Default "Changes". */
  label?: string;
  className?: string;
};

const NOT_SET = "(not set)";

function formatValue(value: unknown): string {
  if (value === undefined || value === null) return NOT_SET;
  if (typeof value === "string") return value;
  return JSON.stringify(value) ?? String(value);
}

function isSet(value: unknown): boolean {
  return value !== undefined && value !== null;
}

const ROW_BG: Record<DiffLine["type"], string> = { add: "bg-ok-tint", remove: "bg-bad-tint", context: "" };
const SIGN: Record<DiffLine["type"], string> = { add: "+", remove: "−", context: " " };
const SIGN_FG: Record<DiffLine["type"], string> = { add: "text-ok", remove: "text-bad", context: "text-soft" };
const SR_PREFIX: Record<DiffLine["type"], string> = { add: "Added: ", remove: "Removed: ", context: "" };

function LineNumber({ value }: { value?: number }) {
  return <td className="w-px select-none whitespace-nowrap px-2 text-right align-top text-soft">{value ?? ""}</td>;
}

function LineText({ line, tinted = true }: { line: DiffLine | null; tinted?: boolean }) {
  if (!line) return <td className="bg-panel2/60 px-2" />;
  return (
    <td className={cn("px-2 align-top", tinted && ROW_BG[line.type])}>
      <span aria-hidden="true" className={cn("mr-2 inline-block w-3 font-semibold", SIGN_FG[line.type])}>
        {SIGN[line.type]}
      </span>
      {SR_PREFIX[line.type] && <span className="sr-only">{SR_PREFIX[line.type]}</span>}
      <span className="whitespace-pre-wrap [overflow-wrap:anywhere]">{line.text}</span>
    </td>
  );
}

function GapRow({ count, columns, onExpand }: { count: number; columns: number; onExpand: () => void }) {
  return (
    <tr className="bg-panel2">
      <td colSpan={columns} className="px-2 py-0.5">
        <button
          type="button"
          onClick={onExpand}
          className="w-full rounded-md px-2 py-0.5 text-left font-sans text-xs text-muted-foreground transition-colors hover:bg-raise hover:text-foreground"
        >
          {count === 1 ? "1 unchanged line" : `${count.toLocaleString("en-US")} unchanged lines`}
        </button>
      </td>
    </tr>
  );
}

function LineTable({ segments, mode, beforeLabel, afterLabel, label, onExpand }: {
  segments: DiffSegment[];
  mode: DiffMode;
  beforeLabel: string;
  afterLabel: string;
  label: string;
  onExpand: (id: string) => void;
}) {
  const columns = mode === "split" ? 4 : 3;
  return (
    <table className={cn("num w-full border-collapse text-[13px] leading-5", mode === "split" ? "min-w-[560px] table-fixed" : "min-w-[460px]")}>
      <caption className="sr-only">{label}</caption>
      {mode === "split" ? (
        <>
          <colgroup>
            <col className="w-12" />
            <col />
            <col className="w-12" />
            <col />
          </colgroup>
          <thead>
            <tr className="border-b border-line text-left font-sans text-xs text-soft">
              <th scope="col" className="px-2 py-1.5 font-medium"><span className="sr-only">{beforeLabel} line</span></th>
              <th scope="col" className="px-2 py-1.5 font-medium">{beforeLabel}</th>
              <th scope="col" className="px-2 py-1.5 font-medium"><span className="sr-only">{afterLabel} line</span></th>
              <th scope="col" className="px-2 py-1.5 font-medium">{afterLabel}</th>
            </tr>
          </thead>
        </>
      ) : (
        <thead className="sr-only">
          <tr>
            <th scope="col">Old line</th>
            <th scope="col">New line</th>
            <th scope="col">Line</th>
          </tr>
        </thead>
      )}
      <tbody>
        {segments.map((segment, index) => {
          if (segment.kind === "gap") {
            return <GapRow key={`gap-${segment.id}`} count={segment.lines.length} columns={columns} onExpand={() => onExpand(segment.id)} />;
          }
          if (mode === "split") {
            return (
              <Fragment key={`seg-${index}`}>
                {toSplitRows(segment.lines).map((row, rowIndex) => (
                  <tr key={rowIndex}>
                    <LineNumber value={row.left?.oldNumber} />
                    <LineText line={row.left} />
                    <LineNumber value={row.right?.newNumber} />
                    <LineText line={row.right} />
                  </tr>
                ))}
              </Fragment>
            );
          }
          return (
            <Fragment key={`seg-${index}`}>
              {segment.lines.map((line, lineIndex) => (
                <tr key={lineIndex} className={ROW_BG[line.type]}>
                  <LineNumber value={line.oldNumber} />
                  <LineNumber value={line.newNumber} />
                  <LineText line={line} tinted={false} />
                </tr>
              ))}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}

function FieldTable({ fields, mode, beforeLabel, afterLabel, label }: {
  fields: readonly DiffField[];
  mode: DiffMode;
  beforeLabel: string;
  afterLabel: string;
  label: string;
}) {
  if (mode === "split") {
    return (
      <table className="num w-full min-w-[560px] border-collapse text-xs leading-5">
        <caption className="sr-only">{label}</caption>
        <thead>
          <tr className="border-b border-line text-left font-sans text-xs text-soft">
            <th scope="col" className="w-[220px] px-3 py-1.5 font-medium">Field</th>
            <th scope="col" className="px-3 py-1.5 font-medium">{beforeLabel}</th>
            <th scope="col" className="px-3 py-1.5 font-medium">{afterLabel}</th>
          </tr>
        </thead>
        <tbody>
          {fields.map((field) => (
            <tr key={field.path} className="border-b border-line last:border-b-0">
              <th scope="row" className="px-3 py-1.5 text-left align-top font-normal text-muted-foreground [overflow-wrap:anywhere]">{field.path}</th>
              {field.secret ? (
                <td colSpan={2} className="px-3 py-1.5 font-sans text-soft italic">Secret value changed (not shown)</td>
              ) : (
                <>
                  <td className="px-3 py-1.5 align-top">
                    <span className={cn("rounded px-1.5 [overflow-wrap:anywhere]", isSet(field.before) ? "bg-bad-tint text-foreground" : "text-soft")}>
                      {isSet(field.before) && <span className="sr-only">Removed: </span>}
                      {formatValue(field.before)}
                    </span>
                  </td>
                  <td className="px-3 py-1.5 align-top">
                    <span className={cn("rounded px-1.5 [overflow-wrap:anywhere]", isSet(field.after) ? "bg-ok-tint text-foreground" : "text-soft")}>
                      {isSet(field.after) && <span className="sr-only">Added: </span>}
                      {formatValue(field.after)}
                    </span>
                  </td>
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
  const rows: { key: string; type: DiffLine["type"]; path: string; value: string; secret?: boolean }[] = [];
  for (const field of fields) {
    if (field.secret) {
      rows.push({ key: `${field.path}:secret`, type: "context", path: field.path, value: "Secret value changed (not shown)", secret: true });
      continue;
    }
    if (isSet(field.before)) rows.push({ key: `${field.path}:-`, type: "remove", path: field.path, value: formatValue(field.before) });
    if (isSet(field.after)) rows.push({ key: `${field.path}:+`, type: "add", path: field.path, value: formatValue(field.after) });
  }
  return (
    <table className="num w-full min-w-[460px] border-collapse text-xs leading-5">
      <caption className="sr-only">{label}</caption>
      <thead className="sr-only">
        <tr>
          <th scope="col">Change</th>
          <th scope="col">Field</th>
          <th scope="col">Value</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.key} className={ROW_BG[row.type]}>
            <td className={cn("w-7 py-[3px] text-center align-top font-semibold", SIGN_FG[row.type])}>
              <span aria-hidden="true">{row.secret ? "~" : SIGN[row.type]}</span>
              <span className="sr-only">{row.secret ? "Changed" : row.type === "add" ? "Added" : "Removed"}</span>
            </td>
            <td className="w-[260px] py-[3px] pr-3 align-top text-muted-foreground [overflow-wrap:anywhere]">{row.path}</td>
            <td className={cn("py-[3px] pr-3 align-top [overflow-wrap:anywhere]", row.secret && "font-sans text-soft italic")}>{row.value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * Shows what changed, unified or side by side: from a line diff, from two
 * JSON values (diffed with sorted keys), or field by field. Additions are
 * tinted green with "+", removals red with "−", and long unchanged runs
 * fold into an "N unchanged lines" button that expands them.
 */
export function DiffView(props: DiffViewProps) {
  const {
    lines,
    fields,
    mode: controlledMode,
    defaultMode = "unified",
    onModeChange,
    showModeToggle = false,
    title,
    beforeLabel = "Before",
    afterLabel = "After",
    context = 3,
    emptyText = "No changes",
    label = "Changes",
    className,
  } = props;
  const [ownMode, setOwnMode] = useState<DiffMode>(defaultMode);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const mode = controlledMode ?? ownMode;
  const setMode = (next: DiffMode) => {
    if (controlledMode === undefined) setOwnMode(next);
    onModeChange?.(next);
  };

  const hasBeforeAfter = "before" in props || "after" in props;
  const { before, after } = props;
  const diff = useMemo<DiffLine[]>(() => {
    if (fields) return [];
    if (lines) return [...lines];
    return hasBeforeAfter ? diffJson(before, after) : [];
  }, [fields, lines, before, after, hasBeforeAfter]);

  const empty = fields ? fields.length === 0 : !hasChanges(diff);
  const segments = useMemo(() => (fields ? [] : foldContext(diff, { context, expanded })), [fields, diff, context, expanded]);

  if (empty) {
    return (
      <div className={cn("rounded-[10px] border border-dashed border-line2 px-4 py-3.5 text-[13px] text-muted-foreground", className)}>
        {emptyText}
      </div>
    );
  }

  const header = title || showModeToggle;
  return (
    <div className={cn("overflow-hidden rounded-[10px] border border-line bg-background", className)}>
      {header && (
        <div className="flex flex-wrap items-center gap-2 border-b border-line bg-panel2 px-3 py-2 text-xs text-muted-foreground">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">{title}</div>
          {showModeToggle && (
            <SegmentedControl
              size="sm"
              label="Diff layout"
              value={mode}
              onChange={setMode}
              options={[
                { value: "unified", label: "Unified" },
                { value: "split", label: "Side by side" },
              ]}
            />
          )}
        </div>
      )}
      <div className="overflow-x-auto py-1">
        {fields ? (
          <FieldTable fields={fields} mode={mode} beforeLabel={beforeLabel} afterLabel={afterLabel} label={label} />
        ) : (
          <LineTable
            segments={segments}
            mode={mode}
            beforeLabel={beforeLabel}
            afterLabel={afterLabel}
            label={label}
            onExpand={(id) => setExpanded((current) => new Set([...current, id]))}
          />
        )}
      </div>
    </div>
  );
}
