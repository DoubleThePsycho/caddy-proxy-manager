"use client";

/**
 * The building blocks of a Settings group: the forms of a group report how
 * many fields differ from what was loaded, one save bar per group saves every
 * changed form through its server action and Discard puts the group back as
 * it was loaded. Fields stay ordinary form fields (uncontrolled inputs,
 * switches and hidden inputs), so the server actions receive exactly the
 * FormData they always did.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useTransition,
  type FormEvent,
  type ReactNode,
} from "react";
import { CircleAlert, CircleCheck, Info, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

export type ActionResult = { success: boolean; message?: string };
export type SettingsFormAction = (prevState: ActionResult | null, formData: FormData) => Promise<ActionResult>;

type Values = Map<string, string[]>;

/**
 * The values a form would submit, by field name, plus disabled fields (so
 * turning an override on counts as one change, not one per field it unlocks).
 * Fields marked data-untracked carry values loaded from elsewhere (another
 * group's field the action also needs) and are not changes of this form.
 */
export function readFormValues(form: HTMLFormElement): Values {
  const values: Values = new Map();
  for (const element of Array.from(form.elements)) {
    if (
      !(element instanceof HTMLInputElement) &&
      !(element instanceof HTMLSelectElement) &&
      !(element instanceof HTMLTextAreaElement)
    ) {
      continue;
    }
    if (!element.name || element.dataset.untracked !== undefined) continue;
    const list = values.get(element.name) ?? [];
    if (element instanceof HTMLInputElement) {
      if (["submit", "button", "reset", "file", "image"].includes(element.type)) continue;
      if ((element.type === "checkbox" || element.type === "radio") && !element.checked) {
        values.set(element.name, list);
        continue;
      }
      list.push(element.value);
    } else if (element instanceof HTMLSelectElement) {
      for (const option of Array.from(element.selectedOptions)) list.push(option.value);
    } else {
      list.push(element.value);
    }
    values.set(element.name, list);
  }
  return values;
}

/** How many field names have another value in `current` than in `initial`. */
export function countChanges(initial: Values, current: Values): number {
  let changes = 0;
  for (const name of new Set([...initial.keys(), ...current.keys()])) {
    if (JSON.stringify(initial.get(name) ?? []) !== JSON.stringify(current.get(name) ?? [])) changes += 1;
  }
  return changes;
}

type Registration = {
  form: HTMLFormElement;
  action: SettingsFormAction;
  /** Read after the form has rendered; null until then. */
  initial: Values | null;
  /** Lower first: the order the forms are saved in. */
  order: number;
};

type GroupApi = {
  register: (id: string, form: HTMLFormElement, action: SettingsFormAction, order: number) => () => void;
  save: () => void;
  canSave: boolean;
};

const GroupContext = createContext<GroupApi | null>(null);

function afterPaint(callback: () => void): () => void {
  if (typeof window === "undefined" || typeof window.requestAnimationFrame !== "function") {
    const timer = setTimeout(callback, 0);
    return () => clearTimeout(timer);
  }
  let second = 0;
  const first = window.requestAnimationFrame(() => {
    second = window.requestAnimationFrame(callback);
  });
  return () => {
    window.cancelAnimationFrame(first);
    if (second) window.cancelAnimationFrame(second);
  };
}

/**
 * A form of a settings group. Submitting it (Enter in a field) saves the
 * whole group, like the save bar does.
 */
export function SettingsForm({
  action,
  order = 0,
  id,
  className,
  children,
}: {
  action: SettingsFormAction;
  /** Forms are saved in this order (lowest first). */
  order?: number;
  id?: string;
  className?: string;
  children?: ReactNode;
}) {
  const group = useContext(GroupContext);
  const generatedId = useId();
  const key = id ?? generatedId;
  const register = group?.register;
  const save = group?.save;
  const actionRef = useRef(action);
  useEffect(() => {
    actionRef.current = action;
  }, [action]);
  const ref = useCallback(
    (form: HTMLFormElement | null) => {
      if (!form || !register) return;
      return register(key, form, (previous, data) => actionRef.current(previous, data), order);
    },
    [register, key, order]
  );
  return (
    <form
      id={id}
      ref={ref}
      className={className}
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        save?.();
      }}
    >
      {children}
    </form>
  );
}

type SaveOutcome = { success: boolean; message: string };

/**
 * One group of a settings page: tracks its forms, shows the save bar under
 * them and reports its number of unsaved changes to the group list. Discard
 * remounts the content, so every field goes back to what was loaded.
 */
export function SettingsGroupForms({
  name,
  canSave,
  readOnlyNote,
  onDirtyChange,
  children,
  after,
  showSaveBar = true,
}: {
  /** Shown under the save bar: parts of the group that save on their own. */
  after?: ReactNode;
  /** The group's name, for "2 unsaved changes in General". */
  name: string;
  /** False when the user's role cannot change these settings. */
  canSave: boolean;
  /** Shown in the save bar instead of the save hint when the role cannot save. */
  readOnlyNote?: string;
  onDirtyChange?: (count: number) => void;
  children: ReactNode;
  /** Groups that save each change on its own (dialogs, switches) have no save bar. */
  showSaveBar?: boolean;
}) {
  const [generation, setGeneration] = useState(0);
  return (
    <TrackedGroup
      key={generation}
      name={name}
      canSave={canSave}
      readOnlyNote={readOnlyNote}
      onDirtyChange={onDirtyChange}
      showSaveBar={showSaveBar}
      after={after}
      onDiscard={() => setGeneration((value) => value + 1)}
    >
      {children}
    </TrackedGroup>
  );
}

function TrackedGroup({
  name,
  canSave,
  readOnlyNote,
  onDirtyChange,
  showSaveBar,
  after,
  onDiscard,
  children,
}: {
  name: string;
  canSave: boolean;
  readOnlyNote?: string;
  onDirtyChange?: (count: number) => void;
  showSaveBar: boolean;
  after?: ReactNode;
  onDiscard: () => void;
  children: ReactNode;
}) {
  const forms = useRef(new Map<string, Registration>());
  const root = useRef<HTMLDivElement>(null);
  const [changes, setChanges] = useState(0);
  const [outcomes, setOutcomes] = useState<SaveOutcome[]>([]);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [saving, startSaving] = useTransition();
  const pendingRecount = useRef<(() => void) | null>(null);
  const reportRef = useRef(onDirtyChange);
  useEffect(() => {
    reportRef.current = onDirtyChange;
  }, [onDirtyChange]);

  const recount = useCallback(() => {
    let total = 0;
    for (const registration of forms.current.values()) {
      if (!registration.initial) continue;
      total += countChanges(registration.initial, readFormValues(registration.form));
    }
    setChanges(total);
  }, []);

  const scheduleRecount = useCallback(() => {
    pendingRecount.current?.();
    pendingRecount.current = afterPaint(() => {
      pendingRecount.current = null;
      recount();
    });
  }, [recount]);

  useEffect(() => {
    reportRef.current?.(changes);
  }, [changes]);

  // A discarded or unmounted group has nothing unsaved.
  useEffect(() => {
    const report = reportRef;
    return () => report.current?.(0);
  }, []);

  // Changes come from typing, switches, selects and buttons, and from
  // components that rewrite hidden inputs or add rows.
  useEffect(() => {
    const element = root.current;
    const pending = pendingRecount;
    if (!element) return;
    const events = ["input", "change", "click", "keyup"] as const;
    for (const type of events) element.addEventListener(type, scheduleRecount);
    const observer = typeof MutationObserver === "undefined" ? null : new MutationObserver(scheduleRecount);
    observer?.observe(element, { subtree: true, childList: true, attributes: true, characterData: true });
    return () => {
      for (const type of events) element.removeEventListener(type, scheduleRecount);
      observer?.disconnect();
      pending.current?.();
    };
  }, [scheduleRecount]);

  const register = useCallback(
    (id: string, form: HTMLFormElement, action: SettingsFormAction, order: number) => {
      const registration: Registration = { form, action, initial: null, order };
      forms.current.set(id, registration);
      // Read what was loaded once the fields (and effects filling hidden inputs) have rendered.
      const cancel = afterPaint(() => {
        if (forms.current.get(id) === registration) {
          registration.initial = readFormValues(form);
          recount();
        }
      });
      return () => {
        cancel();
        if (forms.current.get(id) === registration) forms.current.delete(id);
        scheduleRecount();
      };
    },
    [recount, scheduleRecount]
  );

  const save = useCallback(() => {
    if (!canSave || saving) return;
    const changed = [...forms.current.values()]
      .filter((registration) => registration.initial && countChanges(registration.initial, readFormValues(registration.form)) > 0)
      .sort((a, b) => a.order - b.order);
    if (changed.length === 0) return;
    // The browser's own checks (required, e-mail, number ranges) first.
    for (const registration of changed) {
      if (!registration.form.reportValidity()) return;
    }
    startSaving(async () => {
      const results: SaveOutcome[] = [];
      for (const registration of changed) {
        try {
          const result = await registration.action(null, new FormData(registration.form));
          results.push({ success: result.success, message: result.message ?? (result.success ? "Saved" : "Could not save") });
          // What was saved is now what the form started from.
          if (result.success) registration.initial = readFormValues(registration.form);
        } catch (error) {
          results.push({ success: false, message: error instanceof Error ? error.message : "Could not save" });
        }
      }
      setOutcomes(results);
      if (results.some((result) => result.success)) setSavedAt(new Date());
      recount();
    });
  }, [canSave, saving, recount]);

  const api = useMemo<GroupApi>(() => ({ register, save, canSave }), [register, save, canSave]);

  return (
    <GroupContext.Provider value={api}>
      <div ref={root} className="flex min-w-0 flex-col gap-4">
        {children}
        {showSaveBar && (
          <SaveBar
            name={name}
            changes={changes}
            canSave={canSave}
            readOnlyNote={readOnlyNote}
            saving={saving}
            savedAt={savedAt}
            outcomes={outcomes}
            onSave={save}
            onDiscard={onDiscard}
          />
        )}
        {after}
      </div>
    </GroupContext.Provider>
  );
}

function formatTimeUtc(date: Date): string {
  return `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")} UTC`;
}

function SaveBar({
  name,
  changes,
  canSave,
  readOnlyNote,
  saving,
  savedAt,
  outcomes,
  onSave,
  onDiscard,
}: {
  name: string;
  changes: number;
  canSave: boolean;
  readOnlyNote?: string;
  saving: boolean;
  savedAt: Date | null;
  outcomes: SaveOutcome[];
  onSave: () => void;
  onDiscard: () => void;
}) {
  const dirty = changes > 0;
  const failed = outcomes.filter((outcome) => !outcome.success);
  const text = dirty
    ? `${changes} unsaved ${changes === 1 ? "change" : "changes"} in ${name}`
    : !canSave
      ? readOnlyNote ?? "Your role can read these settings but not change them."
      : savedAt
        ? `Saved at ${formatTimeUtc(savedAt)}.`
        : "No unsaved changes.";
  return (
    <div className="flex flex-col gap-2" data-testid="settings-save-bar">
      {outcomes.length > 0 && (
        <ul
          role="status"
          aria-live="polite"
          className={cn(
            "m-0 flex list-none flex-col gap-1 rounded-xl border border-line2 px-4 py-2.5 text-[13px]",
            failed.length > 0 ? "bg-bad-tint" : "bg-ok-tint"
          )}
        >
          {outcomes.map((outcome, index) => (
            <li key={index} className="flex items-start gap-2">
              {outcome.success ? (
                <CircleCheck aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-ok" />
              ) : (
                <CircleAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-bad" />
              )}
              <span className="min-w-0 break-words">{outcome.message}</span>
            </li>
          ))}
        </ul>
      )}
      <div
        className={cn(
          "flex flex-wrap items-center gap-x-4 gap-y-2.5 rounded-xl border px-4 py-3",
          dirty ? "border-line2 bg-warn-tint" : "border-line bg-panel"
        )}
      >
        <span
          role="status"
          className={cn("flex min-w-0 flex-[1_1_280px] items-center gap-2 text-[13px]", dirty ? "text-foreground" : "text-muted-foreground")}
        >
          <span
            aria-hidden="true"
            className={cn("h-2 w-2 shrink-0 rounded-full", dirty ? "bg-warn" : savedAt && failed.length === 0 ? "bg-ok" : "bg-soft")}
          />
          {text}
        </span>
        <Button type="button" variant="outline" onClick={onDiscard} disabled={!dirty || saving}>
          Discard
        </Button>
        <Button type="button" onClick={onSave} disabled={!dirty || saving || !canSave}>
          {saving ? "Saving…" : "Save changes"}
        </Button>
      </div>
    </div>
  );
}

// ─── Rows and fields ────────────────────────────────────────────────────────

/**
 * One setting: label and hint on the left, the control on the right; they
 * stack on narrow screens. `htmlFor` makes the label a <label>; without it
 * the label is plain text with `labelId`, for groups of buttons.
 */
export function SettingRow({
  label,
  hint,
  htmlFor,
  labelId,
  children,
  note,
  className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  htmlFor?: string;
  labelId?: string;
  children: ReactNode;
  /** A line under the control. */
  note?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-start gap-x-6 gap-y-2 border-t border-line py-3.5", className)}>
      <div className="flex min-w-0 flex-[0_1_210px] flex-col gap-0.5 pt-[7px]">
        {htmlFor ? (
          <label htmlFor={htmlFor} className="font-medium">
            {label}
          </label>
        ) : (
          <span id={labelId} className="font-medium">
            {label}
          </span>
        )}
        {hint && <span className="text-xs leading-4 text-soft">{hint}</span>}
      </div>
      <div className="flex min-w-0 flex-[1_1_320px] flex-col items-start gap-1.5">
        {children}
        {note && <span className="text-xs leading-4 text-soft">{note}</span>}
      </div>
    </div>
  );
}

/** The rows of a card, padded like the design (rows bring their own top line). */
export function SettingRows({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("flex flex-col px-5 pb-1", className)}>{children}</div>;
}

/**
 * An on/off setting submitted as `name=on` (what the server actions read),
 * uncontrolled unless `checked` is given.
 */
export function ToggleField({
  id,
  name,
  label,
  defaultChecked,
  checked,
  onCheckedChange,
  disabled,
}: {
  id: string;
  name?: string;
  label: ReactNode;
  defaultChecked?: boolean;
  checked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <span className="flex min-h-9 items-center gap-2.5">
      <Switch
        id={id}
        name={name}
        defaultChecked={checked === undefined ? defaultChecked : undefined}
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
      />
      <label htmlFor={id} className={cn("cursor-pointer", disabled && "cursor-not-allowed opacity-60")}>
        {label}
      </label>
    </span>
  );
}

/**
 * A choice between a few values, as a row of buttons, submitted through a
 * hidden input named `name`.
 */
export function ChoiceField<T extends string>({
  name,
  label,
  value,
  onChange,
  options,
  disabled,
}: {
  name?: string;
  label: string;
  value: T;
  onChange: (value: T) => void;
  options: readonly { value: T; label: string }[];
  disabled?: boolean;
}) {
  return (
    <>
      <SegmentedControl label={label} value={value} onChange={onChange} options={options} disabled={disabled} />
      {name && <input type="hidden" name={name} value={value} />}
    </>
  );
}

const NOTE_TONE = {
  info: { box: "bg-panel2", icon: "text-muted-foreground", Icon: Info },
  warn: { box: "bg-warn-tint", icon: "text-warn", Icon: TriangleAlert },
  ok: { box: "bg-ok-tint", icon: "text-ok", Icon: CircleCheck },
  bad: { box: "bg-bad-tint", icon: "text-bad", Icon: CircleAlert },
} as const;

/** A note at the end of a card (the design's boxed hint under the rows). */
export function CardNote({ tone = "info", children, className }: { tone?: keyof typeof NOTE_TONE; children: ReactNode; className?: string }) {
  const { box, icon, Icon } = NOTE_TONE[tone];
  return (
    <div role="note" className={cn("mx-5 mb-[18px] mt-1.5 flex items-start gap-2.5 rounded-[10px] border border-line2 px-3 py-2.5 text-[13px]", box, className)}>
      <Icon aria-hidden="true" className={cn("mt-0.5 h-4 w-4 shrink-0", icon)} />
      <div className="min-w-0 [text-wrap:pretty]">{children}</div>
    </div>
  );
}

/**
 * On a replica: whether this card overrides what the master syncs. Submitted
 * as overrideEnabled=on with the card's form.
 */
export function OverrideRow({
  id,
  checked,
  onCheckedChange,
  disabled,
}: {
  id: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <SettingRow label="Master settings" hint="A replica follows its master unless this is on.">
      <ToggleField
        id={id}
        name="overrideEnabled"
        label="Override the master's settings on this replica"
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
      />
    </SettingRow>
  );
}
