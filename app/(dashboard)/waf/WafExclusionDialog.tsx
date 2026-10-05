"use client";

import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { normalizeVariable, pathError, ruleIdError } from "@/src/lib/waf-exclusions";
import { createWafExclusionAction } from "./actions";
import { Segmented } from "./Segmented";

/** The form of the dialog, as strings; `scope` is "global" or a proxy host id. */
export type WafExclusionDraft = { ruleId: string; scope: string; path: string; pathMatch: "exact" | "prefix"; variable: string; reason: string };

export const EMPTY_EXCLUSION_DRAFT: WafExclusionDraft = { ruleId: "", scope: "global", path: "", pathMatch: "prefix", variable: "", reason: "" };

/** A proxy host the exclusion can be limited to. */
export type WafExclusionHostOption = { id: number; name: string; domains: string[] };

/**
 * "Add exclusion": one rule skipped for requests in scope (every host that
 * follows the global settings, or one proxy host, optionally one path and
 * one variable). Used by the WAF settings page and, prefilled from a rule or
 * an event, by the Security events page. Validated here as the server does,
 * then created with createWafExclusionAction (waf:write).
 */
export function WafExclusionDialog({
  open,
  onOpenChange,
  hosts,
  initial = EMPTY_EXCLUSION_DRAFT,
  description = "Skip one rule for the requests in scope.",
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  hosts: readonly WafExclusionHostOption[];
  /** The form's values when it opens; keep the object stable while the dialog is open. */
  initial?: WafExclusionDraft;
  description?: string;
  onCreated?: () => void;
}) {
  const [draft, setDraft] = useState<WafExclusionDraft>(initial);
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (!open) return;
    setDraft(initial);
    setFormError(null);
  }, [open, initial]);

  const setField = <K extends keyof WafExclusionDraft>(key: K, value: WafExclusionDraft[K]) => setDraft((previous) => ({ ...previous, [key]: value }));

  function validate(): { ok: true; ruleId: number } | { ok: false; error: string } {
    const ruleId = /^\d{1,10}$/.test(draft.ruleId.trim()) ? Number(draft.ruleId.trim()) : NaN;
    const ruleError = ruleIdError(ruleId);
    if (ruleError) return { ok: false, error: ruleError.replace(/^ruleId/, "The rule id") };
    if (draft.path.trim()) {
      const error = pathError(draft.path.trim());
      if (error) return { ok: false, error: error.replace(/^path/, "The path") };
    }
    if (draft.variable.trim()) {
      const normalized = normalizeVariable(draft.variable);
      if ("error" in normalized) return { ok: false, error: normalized.error.replace(/^variable/, "The variable") };
    }
    if (!draft.reason.trim()) return { ok: false, error: "Say why the rule is excluded, so others know when it can go." };
    return { ok: true, ruleId };
  }

  function submit() {
    const checked = validate();
    if (!checked.ok) {
      setFormError(checked.error);
      return;
    }
    setFormError(null);
    startTransition(async () => {
      const result = await createWafExclusionAction({
        ruleId: checked.ruleId,
        proxyHostId: draft.scope === "global" ? null : Number(draft.scope),
        path: draft.path.trim() || null,
        pathMatch: draft.path.trim() ? draft.pathMatch : null,
        variable: draft.variable.trim() || null,
        reason: draft.reason.trim(),
      });
      if (!result.ok) {
        setFormError(result.error);
        return;
      }
      toast.success(result.message ?? "Exclusion added");
      onOpenChange(false);
      onCreated?.();
    });
  }

  return (
    <Dialog open={open} onOpenChange={(value) => !pending && onOpenChange(value)}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add exclusion</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="waf-ex-rule">Rule id</Label>
            <Input
              id="waf-ex-rule"
              inputMode="numeric"
              className="font-mono"
              placeholder="942100"
              value={draft.ruleId}
              onChange={(event) => setField("ruleId", event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="waf-ex-scope">Applies to</Label>
            <Select value={draft.scope} onValueChange={(value) => setField("scope", value)}>
              <SelectTrigger id="waf-ex-scope">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="global">Global: hosts that follow or merge with the global settings</SelectItem>
                {hosts.map((host) => (
                  <SelectItem key={host.id} value={String(host.id)}>
                    {host.name}
                    {host.domains[0] && host.domains[0] !== host.name ? ` (${host.domains[0]})` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="waf-ex-path">Path <span className="font-normal text-muted-foreground">(optional)</span></Label>
            <div className="flex flex-wrap gap-2">
              <Input
                id="waf-ex-path"
                className="min-w-0 flex-1 font-mono"
                placeholder="/api/public/"
                value={draft.path}
                onChange={(event) => setField("path", event.target.value)}
              />
              <Segmented
                label="Path match"
                value={draft.pathMatch}
                onChange={(value) => setField("pathMatch", value as WafExclusionDraft["pathMatch"])}
                disabled={!draft.path.trim()}
                options={[
                  { value: "prefix", label: "Starts with" },
                  { value: "exact", label: "Exactly" },
                ]}
              />
            </div>
            <span className="text-xs text-muted-foreground">Without the query string. Empty: every path.</span>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="waf-ex-variable">Variable <span className="font-normal text-muted-foreground">(optional)</span></Label>
            <Input
              id="waf-ex-variable"
              className="font-mono"
              placeholder="ARGS:content"
              value={draft.variable}
              onChange={(event) => setField("variable", event.target.value)}
            />
            <span className="text-xs text-muted-foreground">
              Such as <span className="font-mono">ARGS:name</span>,{" "}
              <span className="font-mono">REQUEST_HEADERS:name</span> or <span className="font-mono">REQUEST_COOKIES:name</span>. Empty: every variable.
            </span>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="waf-ex-reason">Reason</Label>
            <Textarea
              id="waf-ex-reason"
              rows={2}
              maxLength={500}
              placeholder="Runbook pages quote SQL queries in the page body"
              value={draft.reason}
              onChange={(event) => setField("reason", event.target.value.replace(/\n/g, " "))}
            />
          </div>
          {formError && <p role="alert" className="text-sm text-destructive">{formError}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>Cancel</Button>
            <Button type="submit" disabled={pending}>Add exclusion</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
