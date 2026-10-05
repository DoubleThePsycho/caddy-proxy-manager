"use client";

import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { filterCustomDirectives, type DroppedWafDirectiveReport } from "@/src/lib/caddy-waf";
import { appendQuickTemplate, WAF_QUICK_TEMPLATES } from "@/src/lib/waf-quick-templates";
import { ToneDot } from "./waf-settings-shared";

/** Button labels for the shared quick templates. */
const TEMPLATE_LABELS: Record<string, string> = {
  "Allow IP": "Allow IP",
  "Skip OWASP CRS for path": "Skip Core Rule Set for a path",
  "Skip OWASP CRS XSS rules": "Skip XSS rules",
  "Block User-Agent": "Block user agent",
};

const RULE_LINE = /^\s*(SecRule|SecAction)\b/;

/** The global custom SecLang directives, with line numbers, templates and the check Caddy's config builder applies. */
export function WafCustomRules({
  value,
  onChange,
  crsLoaded,
  readOnly,
  droppedDirectives,
}: {
  value: string;
  onChange: (value: string) => void;
  crsLoaded: boolean;
  readOnly: boolean;
  droppedDirectives: DroppedWafDirectiveReport[];
}) {
  const lines = value.split("\n");
  const ruleCount = lines.filter((line) => RULE_LINE.test(line)).length;
  const { dropped } = useMemo(() => filterCustomDirectives(value, { crsLoaded }), [value, crsLoaded]);
  // Lines stored on hosts are reported on the hosts; show them here too, they are the same check.
  const storedElsewhere = droppedDirectives.filter((report) => report.source !== "global WAF settings");

  return (
    <section aria-labelledby="waf-rules-title" className="flex flex-col gap-3 rounded-xl border bg-card p-5">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2.5">
        <div className="flex min-w-0 flex-[1_1_320px] flex-col gap-0.5">
          <h2 id="waf-rules-title" className="text-base font-semibold">Custom rules</h2>
          <span className="text-sm text-muted-foreground">SecLang directives, run after the Core Rule Set.</span>
        </div>
        {!readOnly && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-muted-foreground">Insert</span>
            {WAF_QUICK_TEMPLATES.map((template) => (
              <Button
                key={template.label}
                type="button"
                variant="outline"
                size="sm"
                className="h-[30px] px-2.5 text-xs"
                onClick={() => onChange(appendQuickTemplate(value.replace(/\s+$/, ""), template))}
              >
                {TEMPLATE_LABELS[template.label] ?? template.label}
              </Button>
            ))}
          </div>
        )}
      </div>
      <div className="flex overflow-hidden rounded-lg border bg-background focus-within:ring-2 focus-within:ring-ring">
        <div
          aria-hidden="true"
          className="flex min-w-10 flex-none flex-col border-r bg-muted/40 py-2.5 text-right font-mono text-xs leading-5 text-muted-foreground"
        >
          {lines.map((_, index) => (
            <span key={index} className="px-2.5">{index + 1}</span>
          ))}
        </div>
        <label htmlFor="waf-custom-rules" className="sr-only">Custom SecLang directives</label>
        <textarea
          id="waf-custom-rules"
          wrap="off"
          spellCheck={false}
          readOnly={readOnly}
          rows={Math.max(6, lines.length + 1)}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={`SecRule REQUEST_HEADERS:User-Agent "@contains badbot" "id:9002,phase:1,deny,status:403,log"`}
          className="min-w-0 flex-1 resize-y overflow-x-auto whitespace-pre bg-transparent px-3 py-2.5 font-mono text-[13px] leading-5 outline-none placeholder:text-muted-foreground"
        />
      </div>
      <span className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
        <ToneDot tone={dropped.length === 0 ? "ok" : "bad"} />
        {dropped.length === 0
          ? `${ruleCount} ${ruleCount === 1 ? "rule" : "rules"}, none dropped`
          : `${dropped.length} ${dropped.length === 1 ? "line" : "lines"} would be dropped`}
      </span>
      {dropped.length > 0 && (
        <ul className="flex flex-col gap-1 rounded-lg border border-destructive/40 bg-destructive/5 p-3 font-mono text-xs">
          {dropped.map((line, index) => (
            <li key={`${index}-${line.line}`} className="break-all">
              <span className="text-foreground">{line.line}</span> <span className={cn("text-destructive")}>→ {line.reason}</span>
            </li>
          ))}
        </ul>
      )}
      {storedElsewhere.length > 0 && (
        <div role="note" className="rounded-lg border bg-muted/30 p-3 text-sm">
          <p>
            {storedElsewhere.length} custom directive {storedElsewhere.length === 1 ? "line" : "lines"} stored on proxy hosts{" "}
            {storedElsewhere.length === 1 ? "is" : "are"} dropped. Rewrite or remove {storedElsewhere.length === 1 ? "it" : "them"} in the host settings:
          </p>
          <ul className="mt-2 list-disc pl-5 font-mono text-xs break-all">
            {storedElsewhere.map((report) => (
              <li key={`${report.source}\n${report.line}\n${report.reason}`}>
                {report.source}: &quot;{report.line}&quot; → {report.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
