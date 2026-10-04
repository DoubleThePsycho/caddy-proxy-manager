"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowDown, ArrowUp, Check, Copy, KeyRound, MoreHorizontal, Pencil, Plus, Trash2, Undo2, X } from "lucide-react";
import { toast } from "sonner";
import type { AccessList, AccessListUsage, BlockedSourcesPlaceholder } from "@/lib/models/access-lists";
import type { ListStats } from "@/lib/access-list-stats";
import {
  ACCESS_LIST_RULE_KINDS,
  CONTINENTS,
  classifyAccessList,
  continentName,
  countryName,
  normalizeMemberInput,
  ruleKindLabel,
  ruleValuesText,
  type AccessListRuleAction,
  type AccessListRuleKind,
} from "@/lib/access-list-rules";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import {
  draftFromList,
  draftRuleError,
  draftToSave,
  generatePassword,
  isDraftDirty,
  moveRule,
  newDraftMember,
  newDraftRule,
  parseDraftValues,
  type AccessListDraft,
  type DraftMember,
  type DraftRule,
} from "./access-list-draft";
import { deleteAccessListAction, saveAccessListAction, saveBlockedSourcesAction } from "./actions";

export type EditableList = AccessList | BlockedSourcesPlaceholder;

const KIND_OPTIONS: Record<AccessListRuleKind, { label: string; placeholder: string; hint: string }> = {
  ip: {
    label: "Address or network",
    placeholder: "203.0.113.0/24, 2001:db8::/48",
    hint: "IPv4 or IPv6 addresses and CIDR ranges, separated by commas. private_ranges covers the private networks.",
  },
  country: { label: "Country", placeholder: "IT, FR, DE", hint: "Two-letter country codes, separated by commas." },
  continent: {
    label: "Continent",
    placeholder: "EU",
    hint: `Continent codes: ${CONTINENTS.map((continent) => `${continent.code} ${continent.name}`).join(", ")}.`,
  },
  asn: { label: "AS number", placeholder: "AS64500", hint: "AS numbers, with or without the AS prefix." },
};

function fmt(value: number): string {
  return value.toLocaleString("en-US");
}

function fmtDay(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

/** ISO 8601 to the value of a datetime-local input, in local time. */
function toLocalInput(iso: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function fromLocalInput(value: string): string {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function ruleLabel(rule: DraftRule): string {
  const values = parseDraftValues(rule.kind, rule.valuesText).values;
  return `${rule.action === "allow" ? "Allow" : "Deny"} ${ruleKindLabel(rule.kind, values).toLowerCase()} ${values.join(", ") || "(empty)"}`;
}

function TypePill({ label, basicAuth }: { label: string; basicAuth?: boolean }) {
  return (
    <span className="inline-flex h-[22px] items-center gap-1.5 whitespace-nowrap rounded-full border px-2 text-xs">
      <span className={cn("h-1.5 w-1.5 rounded-full", basicAuth ? "bg-primary" : "bg-access")} aria-hidden="true" />
      {label}
    </span>
  );
}

function RuleEditFields({
  rule,
  system,
  onChange,
}: {
  rule: DraftRule;
  system: boolean;
  onChange: (rule: DraftRule) => void;
}) {
  const parsed = parseDraftValues(rule.kind, rule.valuesText);
  const option = KIND_OPTIONS[rule.kind];
  const idBase = `rule-${rule.key}`;
  return (
    <div className="grid gap-3 pt-1">
      <div className="grid gap-3 sm:grid-cols-[140px_minmax(0,1fr)]">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${idBase}-action`} className="text-[13px]">Action</Label>
          {system ? (
            <span id={`${idBase}-action`} className="flex h-9 items-center text-sm">Deny</span>
          ) : (
            <Select value={rule.action} onValueChange={(value) => onChange({ ...rule, action: value as AccessListRuleAction })}>
              <SelectTrigger id={`${idBase}-action`} className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="allow">Allow</SelectItem>
                <SelectItem value="deny">Deny</SelectItem>
              </SelectContent>
            </Select>
          )}
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${idBase}-kind`} className="text-[13px]">Match by</Label>
          <Select value={rule.kind} onValueChange={(value) => onChange({ ...rule, kind: value as AccessListRuleKind })}>
            <SelectTrigger id={`${idBase}-kind`} className="h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ACCESS_LIST_RULE_KINDS.map((kind) => (
                <SelectItem key={kind} value={kind}>{KIND_OPTIONS[kind].label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${idBase}-values`} className="text-[13px]">Values</Label>
        <Input
          id={`${idBase}-values`}
          className="h-9 font-mono text-[13px]"
          value={rule.valuesText}
          placeholder={option.placeholder}
          autoFocus={rule.isNew}
          onChange={(event) => onChange({ ...rule, valuesText: event.target.value })}
          aria-describedby={`${idBase}-values-hint`}
          aria-invalid={parsed.errors.length > 0}
        />
        <span id={`${idBase}-values-hint`} className={cn("text-xs", parsed.errors.length > 0 ? "text-destructive" : "text-muted-foreground")}>
          {parsed.errors.length > 0 ? parsed.errors[0] : option.hint}
        </span>
        {(rule.kind === "country" || rule.kind === "continent") && parsed.values.length > 0 && (
          <span className="flex flex-wrap gap-1.5">
            {parsed.values.map((value) => (
              <span key={value} className="rounded-md bg-muted px-1.5 py-0.5 text-xs">
                <span className="font-mono">{value}</span> {rule.kind === "country" ? countryName(value) : continentName(value)}
              </span>
            ))}
          </span>
        )}
      </div>
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_220px]">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${idBase}-note`} className="text-[13px]">{system ? "Reason" : "Note"}</Label>
          <Input
            id={`${idBase}-note`}
            className="h-9 text-[13px]"
            value={rule.note}
            maxLength={500}
            placeholder={system ? "Why it is blocked" : "Optional"}
            onChange={(event) => onChange({ ...rule, note: event.target.value })}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${idBase}-expires`} className="text-[13px]">Expires</Label>
          <Input
            id={`${idBase}-expires`}
            type="datetime-local"
            className="h-9 text-[13px]"
            value={toLocalInput(rule.expiresAt)}
            onChange={(event) => onChange({ ...rule, expiresAt: fromLocalInput(event.target.value) })}
          />
        </div>
      </div>
    </div>
  );
}

function RuleRow({
  rule,
  index,
  count,
  system,
  editing,
  canWrite,
  onEdit,
  onDone,
  onChange,
  onMove,
  onRemove,
}: {
  rule: DraftRule;
  index: number;
  count: number;
  system: boolean;
  editing: boolean;
  canWrite: boolean;
  onEdit: () => void;
  onDone: () => void;
  onChange: (rule: DraftRule) => void;
  onMove: (delta: -1 | 1) => void;
  onRemove: () => void;
}) {
  const label = ruleLabel(rule);
  const values = parseDraftValues(rule.kind, rule.valuesText).values;
  const allow = rule.action === "allow";
  const expired = rule.expiresAt !== "" && new Date(rule.expiresAt).getTime() <= Date.now();
  const note = [
    rule.note,
    rule.expiresAt ? (expired ? "Expired, removed within a minute" : `Expires ${fmtDateTime(rule.expiresAt)}`) : "",
    rule.isNew ? "New rule, not saved" : "",
  ].filter(Boolean).join(" · ");
  return (
    <li
      className={cn(
        "grid grid-cols-[22px_72px_minmax(0,1fr)_auto] items-center gap-2.5 py-2.5 pl-3 pr-2 hover:bg-muted/40",
        index > 0 && "border-t",
        rule.isNew && "bg-primary/10"
      )}
      data-testid="access-list-rule"
    >
      <span className="font-mono text-xs text-muted-foreground">{index + 1}</span>
      <span className={cn("inline-flex items-center gap-1.5 text-[13px] font-semibold", allow ? "text-ok" : "text-bad")}>
        <span className={cn("h-2 w-2 rounded-full", allow ? "bg-ok" : "bg-bad")} aria-hidden="true" />
        {allow ? "Allow" : "Deny"}
      </span>
      <span className="flex min-w-0 flex-col gap-px">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="flex-none text-xs text-muted-foreground">{ruleKindLabel(rule.kind, values)}</span>
          <span className={cn("truncate font-mono text-[13px]", values.length === 0 && "text-muted-foreground")}>
            {values.length > 0 ? ruleValuesText(rule.kind, values) : "Choose values"}
          </span>
        </span>
        {note && <span className={cn("text-xs", expired ? "text-warn" : "text-muted-foreground")}>{note}</span>}
      </span>
      <span className="flex">
        {canWrite && (
          <>
            <Button type="button" variant="ghost" size="icon" className="h-7 w-7" aria-label={`${editing ? "Done editing" : "Edit"}: ${label}`} onClick={editing ? onDone : onEdit}>
              {editing ? <Check className="h-3.5 w-3.5" /> : <Pencil className="h-3.5 w-3.5" />}
            </Button>
            <Button type="button" variant="ghost" size="icon" className="h-7 w-7" aria-label={`Move up: ${label}`} disabled={index === 0} onClick={() => onMove(-1)}>
              <ArrowUp className="h-3.5 w-3.5" />
            </Button>
            <Button type="button" variant="ghost" size="icon" className="h-7 w-7" aria-label={`Move down: ${label}`} disabled={index === count - 1} onClick={() => onMove(1)}>
              <ArrowDown className="h-3.5 w-3.5" />
            </Button>
            <Button type="button" variant="ghost" size="icon" className="h-7 w-7" aria-label={`Remove rule: ${label}`} onClick={onRemove}>
              <X className="h-3.5 w-3.5" />
            </Button>
          </>
        )}
      </span>
      {editing && (
        <div className="col-span-4 border-t pt-2">
          <RuleEditFields rule={rule} system={system} onChange={onChange} />
        </div>
      )}
    </li>
  );
}

function MemberRow({
  member,
  index,
  canWrite,
  onChange,
  onRemove,
}: {
  member: DraftMember;
  index: number;
  canWrite: boolean;
  onChange: (member: DraftMember) => void;
  onRemove: () => void;
}) {
  const shownPassword = member.id === null ? member.password : member.newPassword;
  const status = member.removed
    ? "Removed when you save"
    : member.id === null
      ? "Not saved yet"
      : member.newPassword
        ? "New password when you save"
        : member.createdAt
          ? `Added ${fmtDay(member.createdAt)}`
          : "";
  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success("Password copied");
    } catch {
      toast.error("Could not copy the password");
    }
  };
  return (
    <li className={cn("flex flex-wrap items-center gap-2.5 py-2 pl-3 pr-2", index > 0 && "border-t")} data-testid="access-list-member">
      <span className={cn("min-w-0 flex-1 font-mono text-[13px]", member.removed && "text-muted-foreground line-through")}>{member.username}</span>
      {shownPassword && !member.removed && (
        <span className="flex items-center gap-1">
          <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{shownPassword}</code>
          <Button type="button" variant="ghost" size="icon" className="h-7 w-7" aria-label={`Copy the password of ${member.username}`} onClick={() => copy(shownPassword)}>
            <Copy className="h-3.5 w-3.5" />
          </Button>
        </span>
      )}
      <span className="text-xs text-muted-foreground">{status}</span>
      {canWrite && (
        <span className="flex">
          {member.id !== null && !member.removed && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              aria-label={`New password for ${member.username}`}
              title="Generate a new password"
              onClick={() => onChange({ ...member, newPassword: generatePassword() })}
            >
              <KeyRound className="h-3.5 w-3.5" />
            </Button>
          )}
          {member.removed ? (
            <Button type="button" variant="ghost" size="icon" className="h-7 w-7" aria-label={`Keep ${member.username}`} onClick={() => onChange({ ...member, removed: false })}>
              <Undo2 className="h-3.5 w-3.5" />
            </Button>
          ) : (
            <Button type="button" variant="ghost" size="icon" className="h-7 w-7" aria-label={`Remove ${member.username}`} onClick={onRemove}>
              <X className="h-3.5 w-3.5" />
            </Button>
          )}
        </span>
      )}
    </li>
  );
}

export function AccessListEditor({
  list,
  usage,
  listStats,
  blockedSourcesStopped,
  statsAvailable,
  canWrite,
  trustedProxiesConfigured,
  onDirtyChange,
  onSaved,
  onDeleted,
}: {
  list: EditableList;
  usage: AccessListUsage[];
  listStats: ListStats | null;
  blockedSourcesStopped: number | null;
  statsAvailable: boolean;
  canWrite: boolean;
  trustedProxiesConfigured: boolean;
  onDirtyChange: (dirty: boolean) => void;
  /** The saved list; null when it was stored but Caddy did not take the configuration. */
  onSaved: (list: AccessList | null) => void;
  onDeleted: () => void;
}) {
  const system = list.system !== null;
  const saved = useMemo(() => draftFromList(list), [list]);
  const [draft, setDraft] = useState<AccessListDraft>(saved);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [newMember, setNewMember] = useState({ username: "", password: "" });
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const dirty = isDraftDirty(draft, saved);
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);

  const type = classifyAccessList({
    systemKey: list.system,
    defaultAction: draft.defaultAction,
    rules: draft.rules,
    memberCount: draft.members.filter((member) => !member.removed).length,
  });

  const setRules = (rules: DraftRule[]) => setDraft((current) => ({ ...current, rules }));
  const setMembers = (members: DraftMember[]) => setDraft((current) => ({ ...current, members }));

  const finishEditing = (rule: DraftRule) => {
    const error = draftRuleError(rule);
    if (error) {
      toast.error(error);
      return;
    }
    setEditingKey(null);
  };

  const addRule = () => {
    const rule = newDraftRule("deny", system ? "ip" : "country");
    setRules([...draft.rules, rule]);
    setEditingKey(rule.key);
  };

  const addMember = () => {
    try {
      const member = normalizeMemberInput({ username: newMember.username, password: newMember.password });
      if (draft.members.some((existing) => existing.username === member.username && !existing.removed)) {
        toast.error(`The list already has a member named ${member.username}`);
        return;
      }
      setMembers([...draft.members, newDraftMember(member.username, member.password)]);
      setNewMember({ username: "", password: "" });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Check the username and password");
    }
  };

  const validate = (): string | null => {
    if (!system && !draft.name.trim()) return "Give the list a name";
    for (const rule of draft.rules) {
      const error = draftRuleError(rule);
      if (error) return `Rule ${draft.rules.indexOf(rule) + 1}: ${error}`;
    }
    const status = Number(draft.denyStatus.trim());
    if (!draft.denyRedirectUrl.trim() && (!Number.isInteger(status) || status < 400 || status > 599)) {
      return "The status of a denied request must be from 400 to 599";
    }
    return null;
  };

  const save = async () => {
    const problem = validate();
    if (problem) {
      toast.error(problem);
      return;
    }
    setSaving(true);
    try {
      const payload = draftToSave(draft, { system, expectedUpdatedAt: list.updatedAt });
      const result = system ? await saveBlockedSourcesAction(payload) : await saveAccessListAction(list.id as number, payload);
      if (!result.ok) {
        toast.error(result.error);
        if (result.saved) onSaved(null);
        return;
      }
      setEditingKey(null);
      toast.success(system ? "Blocked sources saved" : `Saved ${result.value.name}`);
      onSaved(result.value);
    } finally {
      setSaving(false);
    }
  };

  const discard = () => {
    setDraft(saved);
    setEditingKey(null);
    setNewMember({ username: "", password: "" });
  };

  const remove = async () => {
    if (system || list.id === null) return;
    const result = await deleteAccessListAction(list.id);
    setConfirmDelete(false);
    if (!result.ok) {
      toast.error(result.error);
      if (result.saved) onDeleted();
      return;
    }
    toast.success(`Deleted ${list.name}`);
    onDeleted();
  };

  const hostCount = usage.length;
  const saveNote = system
    ? "Saving changes every host at once."
    : hostCount === 0
      ? "No host uses this list yet; attach it from a proxy host's settings."
      : `Saving changes ${hostCount === 1 ? "1 host" : `${hostCount} hosts`} at once.`;
  const unmatchedText = draft.defaultAction === "deny" ? "is denied" : "goes through";

  return (
    <aside
      aria-labelledby="access-list-editor-title"
      className="flex min-w-0 flex-[2_1_560px] flex-col overflow-hidden rounded-[14px] border bg-card"
      data-testid="access-list-editor"
    >
      <div className="flex flex-col gap-3 border-b px-5 py-4">
        <div className="flex items-center gap-2.5">
          <TypePill label={type.label} basicAuth={type.type === "basic_auth"} />
          <h2 id="access-list-editor-title" className="min-w-0 flex-1 truncate text-base font-semibold">
            {system ? list.name : draft.name.trim() || "Untitled list"}
          </h2>
          {!system && canWrite && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="ghost" size="icon" className="h-8 w-8" aria-label="More actions for this list">
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem className="text-destructive" onSelect={() => setConfirmDelete(true)}>
                  <Trash2 className="h-4 w-4" /> Delete list
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(180px,100%),1fr))] gap-x-3.5 gap-y-2.5">
          <div className="flex min-w-0 flex-col gap-1.5">
            <Label htmlFor="access-list-name" className="text-[13px]">Name</Label>
            <Input
              id="access-list-name"
              className="h-9 text-[13px]"
              value={draft.name}
              maxLength={200}
              disabled={!canWrite || system}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
          </div>
          <div className="flex min-w-0 flex-col gap-1.5">
            <Label htmlFor="access-list-description" className="text-[13px]">Description</Label>
            <Input
              id="access-list-description"
              className="h-9 text-[13px]"
              value={draft.description}
              maxLength={1000}
              disabled={!canWrite}
              onChange={(event) => setDraft({ ...draft, description: event.target.value })}
            />
          </div>
        </div>
      </div>

      <section aria-labelledby="access-list-rules-title" className="flex flex-col gap-2.5 border-b px-5 py-4">
        <div className="flex items-center gap-2.5">
          <h3 id="access-list-rules-title" className="flex-1 text-sm font-semibold">Rules, in the order they are checked</h3>
          {canWrite && (
            <Button type="button" variant="outline" size="sm" className="h-8" onClick={addRule}>
              <Plus className="h-3.5 w-3.5" /> Add rule
            </Button>
          )}
        </div>
        {draft.rules.length > 0 ? (
          <ol className="flex flex-col overflow-hidden rounded-[10px] border">
            {draft.rules.map((rule, index) => (
              <RuleRow
                key={rule.key}
                rule={rule}
                index={index}
                count={draft.rules.length}
                system={system}
                editing={editingKey === rule.key}
                canWrite={canWrite}
                onEdit={() => setEditingKey(rule.key)}
                onDone={() => finishEditing(rule)}
                onChange={(next) => setRules(draft.rules.map((item) => (item.key === rule.key ? next : item)))}
                onMove={(delta) => setRules(moveRule(draft.rules, index, delta))}
                onRemove={() => {
                  setRules(draft.rules.filter((item) => item.key !== rule.key));
                  if (editingKey === rule.key) setEditingKey(null);
                }}
              />
            ))}
          </ol>
        ) : (
          <p className="rounded-[10px] border border-dashed px-3 py-4 text-sm text-muted-foreground">
            {system
              ? "Nothing is blocked. Add an address or network here, or use Block on a Security events entry."
              : `No rules. Every request ${unmatchedText}${draft.members.length > 0 ? " to the sign-in" : ""}.`}
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          {system
            ? "Checked on every host before anything else, rate limiting and the WAF included. Requests it does not name go through."
            : `The first rule that matches decides. A request that matches no rule ${unmatchedText}. Countries, continents and AS numbers come from GeoLite2, updated every 72 hours.`}{" "}
          Client addresses follow Settings, Trusted proxies.
        </p>
        {!system && (
          <div className="flex flex-wrap items-center gap-3 pt-1">
            <Label htmlFor="access-list-unmatched" className="text-[13px]">When no rule matches</Label>
            <Select
              value={draft.defaultAction}
              disabled={!canWrite}
              onValueChange={(value) => setDraft({ ...draft, defaultAction: value === "deny" ? "deny" : "allow" })}
            >
              <SelectTrigger id="access-list-unmatched" className="h-9 w-[230px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="allow">Let the request through</SelectItem>
                <SelectItem value="deny">Deny the request</SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}
      </section>

      <section aria-labelledby="access-list-response-title" className="flex flex-col gap-2.5 border-b px-5 py-4">
        <h3 id="access-list-response-title" className="text-sm font-semibold">What a denied visitor gets</h3>
        <div className="grid grid-cols-[96px_minmax(0,1fr)] gap-x-3 gap-y-2.5">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="access-list-status" className="text-[13px]">Status</Label>
            <Input
              id="access-list-status"
              inputMode="numeric"
              className="h-9 font-mono text-[13px]"
              value={draft.denyStatus}
              disabled={!canWrite || draft.denyRedirectUrl.trim() !== ""}
              onChange={(event) => setDraft({ ...draft, denyStatus: event.target.value })}
            />
          </div>
          <div className="flex min-w-0 flex-col gap-1.5">
            <Label htmlFor="access-list-body" className="text-[13px]">Body</Label>
            <Input
              id="access-list-body"
              className="h-9 text-[13px]"
              value={draft.denyBody}
              placeholder="Forbidden"
              maxLength={4096}
              disabled={!canWrite || draft.denyRedirectUrl.trim() !== ""}
              onChange={(event) => setDraft({ ...draft, denyBody: event.target.value })}
            />
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="access-list-redirect" className="text-[13px]">Or redirect to</Label>
          <Input
            id="access-list-redirect"
            className="h-9 font-mono text-[13px]"
            value={draft.denyRedirectUrl}
            placeholder="https://example.com/not-available"
            disabled={!canWrite}
            onChange={(event) => setDraft({ ...draft, denyRedirectUrl: event.target.value })}
          />
        </div>
        <div className="flex items-start gap-3.5 pt-1">
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <Label htmlFor="access-list-fail-closed" className="text-[13px]">Block when the client address is unknown</Label>
            <span className="text-xs text-muted-foreground">
              {trustedProxiesConfigured
                ? "Behind a trusted proxy that sends no usable X-Forwarded-For. Off lets those requests through."
                : "Only matters behind trusted proxies, and none are configured: the client address is always known."}
            </span>
          </span>
          <Switch
            id="access-list-fail-closed"
            checked={draft.failClosed}
            disabled={!canWrite}
            onCheckedChange={(checked) => setDraft({ ...draft, failClosed: checked })}
          />
        </div>
      </section>

      {!system && (
        <section aria-labelledby="access-list-members-title" className="flex flex-col gap-2.5 border-b px-5 py-4">
          <h3 id="access-list-members-title" className="text-sm font-semibold">Members</h3>
          <p className="text-xs text-muted-foreground">
            With members, visitors sign in with a username and password after the rules let them through. Without any, nobody is asked to sign in.
          </p>
          {draft.members.length > 0 && (
            <ul className="flex flex-col overflow-hidden rounded-[10px] border">
              {draft.members.map((member, index) => (
                <MemberRow
                  key={member.key}
                  member={member}
                  index={index}
                  canWrite={canWrite}
                  onChange={(next) => setMembers(draft.members.map((item) => (item.key === member.key ? next : item)))}
                  onRemove={() =>
                    setMembers(
                      member.id === null
                        ? draft.members.filter((item) => item.key !== member.key)
                        : draft.members.map((item) => (item.key === member.key ? { ...item, removed: true } : item))
                    )
                  }
                />
              ))}
            </ul>
          )}
          {canWrite && (
            <div className="grid grid-cols-1 items-end gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto_auto]">
              <div className="flex min-w-0 flex-col gap-1.5">
                <Label htmlFor="access-list-member-username" className="text-[13px]">Username</Label>
                <Input
                  id="access-list-member-username"
                  className="h-9 font-mono text-[13px]"
                  value={newMember.username}
                  placeholder="s.conti"
                  autoComplete="off"
                  onChange={(event) => setNewMember({ ...newMember, username: event.target.value })}
                />
              </div>
              <div className="flex min-w-0 flex-col gap-1.5">
                <Label htmlFor="access-list-member-password" className="text-[13px]">Password</Label>
                <Input
                  id="access-list-member-password"
                  className="h-9 font-mono text-[13px]"
                  value={newMember.password}
                  placeholder="Paste or generate"
                  autoComplete="new-password"
                  onChange={(event) => setNewMember({ ...newMember, password: event.target.value })}
                />
              </div>
              <Button type="button" variant="outline" className="h-9" onClick={() => setNewMember({ ...newMember, password: generatePassword() })}>
                Generate
              </Button>
              <Button type="button" variant="outline" className="h-9" disabled={!newMember.username.trim() || !newMember.password} onClick={addMember}>
                Add member
              </Button>
            </div>
          )}
          <p className="text-xs text-muted-foreground">Passwords are stored only as bcrypt hashes. Copy a new one before you save.</p>
        </section>
      )}

      <section aria-labelledby="access-list-usage-title" className="flex flex-col gap-2 border-b px-5 py-4">
        <h3 id="access-list-usage-title" className="text-sm font-semibold">Where it is used</h3>
        <ul className="flex flex-col">
          {system ? (
            <li className="flex items-start gap-2.5 py-2">
              <span className="flex min-w-0 flex-1 flex-col gap-px">
                <span className="text-[13px]">Every host</span>
                <span className="text-xs text-muted-foreground">Global list, checked before each host&apos;s own list</span>
              </span>
              <span className="flex flex-col items-end">
                <span className="font-mono text-[13px]">{blockedSourcesStopped === null ? "—" : fmt(blockedSourcesStopped)}</span>
                <span className="text-xs text-muted-foreground">stopped, 24 h</span>
              </span>
            </li>
          ) : usage.length === 0 ? (
            <li className="py-2 text-[13px] text-muted-foreground">No host uses this list yet.</li>
          ) : (
            usage.map((host, index) => {
              const hostStats = listStats?.hosts[host.id];
              const basicAuth = draft.members.some((member) => member.id !== null);
              return (
                <li key={host.id} className={cn("flex items-start gap-2.5 py-2", index > 0 && "border-t")}>
                  <span className="flex min-w-0 flex-1 flex-col gap-px">
                    <Link
                      href={`/proxy-hosts?search=${encodeURIComponent(host.domains[0] ?? host.name)}`}
                      className="truncate font-mono text-[13px] text-foreground hover:underline"
                    >
                      {host.domains[0] ?? host.name}
                    </Link>
                    <span className="text-xs text-muted-foreground">
                      {[host.name !== host.domains[0] ? host.name : "", host.domains.length > 1 ? `${host.domains.length - 1} more domains` : "", host.enabled ? "" : "Disabled"]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </span>
                  <span className="flex flex-col items-end">
                    <span className="font-mono text-[13px]">
                      {!statsAvailable ? "—" : fmt(basicAuth && !hostStats?.stopped ? hostStats?.failedSignIns ?? 0 : hostStats?.stopped ?? 0)}
                    </span>
                    <span className="text-xs text-muted-foreground">{basicAuth && !hostStats?.stopped ? "failed sign-ins" : "stopped"}</span>
                  </span>
                </li>
              );
            })
          )}
        </ul>
      </section>

      <div className="flex flex-col gap-2.5 bg-muted/40 px-5 pb-4 pt-3.5">
        <span className="text-xs text-muted-foreground">
          {canWrite ? saveNote : "You can see this list but not change it: that needs the access_lists:write permission."}
        </span>
        <div className="flex flex-wrap items-center gap-2">
          <span className="flex flex-[1_1_160px] items-center gap-2 text-[13px] text-muted-foreground" role="status">
            <span className={cn("h-2 w-2 rounded-full", dirty ? "bg-primary" : "bg-ok")} aria-hidden="true" />
            {dirty ? "Unsaved changes" : "Saved · matches the running configuration"}
          </span>
          {canWrite && (
            <>
              <Button type="button" variant="ghost" size="sm" disabled={!dirty || saving} onClick={discard}>
                Discard
              </Button>
              <Button type="button" size="sm" disabled={!dirty || saving} onClick={save}>
                {saving ? "Saving" : "Save list"}
              </Button>
            </>
          )}
        </div>
      </div>

      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Delete {list.name}?</DialogTitle>
            <DialogDescription>
              {hostCount > 0
                ? `${hostCount === 1 ? "The host" : `The ${hostCount} hosts`} using it lose its rules and members and let everyone through again.`
                : "No host uses it. Its rules and members are deleted with it."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setConfirmDelete(false)}>Cancel</Button>
            <Button type="button" variant="destructive" onClick={remove}>Delete list</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </aside>
  );
}
