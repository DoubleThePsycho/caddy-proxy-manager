"use client";

import { useState } from "react";
import { Gauge, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  RATE_LIMIT_KEYS,
  RATE_LIMIT_KEY_LABELS,
  RATE_LIMIT_LIMITS,
  RATE_LIMIT_METHODS,
  defaultRateLimitRule,
  type ProxyHostRateLimit,
  type RateLimitKey,
  type RateLimitMode,
  type RateLimitRule,
  type RateLimitSettings,
} from "@/lib/rate-limit-rules";

// ─── Rules editor ────────────────────────────────────────────────────────────

type WindowUnit = "s" | "m" | "h";

type RuleState = {
  path: string;
  methods: string[];
  key: RateLimitKey;
  header: string;
  events: string;
  windowValue: string;
  windowUnit: WindowUnit;
};

const UNIT_LABELS: Record<WindowUnit, string> = { s: "seconds", m: "minutes", h: "hours" };

function toState(rule: RateLimitRule): RuleState {
  const match = /^(\d+)(s|m|h)$/.exec(rule.window);
  return {
    path: rule.path === "*" ? "" : rule.path,
    methods: [...rule.methods],
    key: rule.key,
    header: rule.header ?? "",
    events: String(rule.events),
    windowValue: match?.[1] ?? "1",
    windowUnit: (match?.[2] as WindowUnit | undefined) ?? "m",
  };
}

/** The rules as the server validates them; it reports anything wrong with the field that is wrong. */
function toRules(rules: RuleState[]): Array<Record<string, unknown>> {
  return rules.map((rule) => ({
    path: rule.path.trim() || "*",
    methods: rule.methods,
    key: rule.key,
    ...(rule.key === "header" ? { header: rule.header.trim() } : {}),
    events: Number(rule.events),
    window: `${rule.windowValue.trim()}${rule.windowUnit}`,
  }));
}

function RateLimitRulesEditor({
  rules,
  onChange,
  showUserKeyHint = true,
}: {
  rules: RuleState[];
  onChange: (rules: RuleState[]) => void;
  showUserKeyHint?: boolean;
}) {
  const update = (index: number, patch: Partial<RuleState>) =>
    onChange(rules.map((rule, i) => (i === index ? { ...rule, ...patch } : rule)));
  const toggleMethod = (index: number, method: string) => {
    const current = rules[index].methods;
    update(index, {
      methods: current.includes(method) ? current.filter((m) => m !== method) : [...current, method],
    });
  };

  return (
    <div className="flex flex-col gap-2">
      {rules.map((rule, i) => (
        <div key={i} className="rounded-md border border-border p-3 flex flex-col gap-2" data-testid="rate-limit-rule">
          <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto_40px] gap-2 items-center">
            <Input
              size={1}
              aria-label="Path"
              placeholder="Path, e.g. /login or /api/* (blank = every path)"
              value={rule.path}
              onChange={(e) => update(i, { path: e.target.value })}
              className="h-8 text-sm"
            />
            <Select value={rule.key} onValueChange={(value) => update(i, { key: value as RateLimitKey })}>
              <SelectTrigger className="h-8 text-sm sm:w-[170px]" aria-label="Count requests by">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {RATE_LIMIT_KEYS.map((key) => (
                  <SelectItem key={key} value={key}>
                    Per {RATE_LIMIT_KEY_LABELS[key].toLowerCase()}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              aria-label="Remove rule"
              onClick={() => onChange(rules.filter((_, idx) => idx !== i))}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
          {rule.key === "header" && (
            <Input
              size={1}
              aria-label="Header name"
              placeholder="Header name, e.g. X-Api-Key"
              value={rule.header}
              onChange={(e) => update(i, { header: e.target.value })}
              className="h-8 text-sm"
            />
          )}
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Input
              type="number"
              min={1}
              max={RATE_LIMIT_LIMITS.maxEvents}
              step={1}
              aria-label="Requests"
              value={rule.events}
              onChange={(e) => update(i, { events: e.target.value })}
              className="h-8 w-24 text-sm"
            />
            <span className="text-muted-foreground">requests per</span>
            <Input
              type="number"
              min={1}
              step={1}
              aria-label="Window"
              value={rule.windowValue}
              onChange={(e) => update(i, { windowValue: e.target.value })}
              className="h-8 w-20 text-sm"
            />
            <Select value={rule.windowUnit} onValueChange={(value) => update(i, { windowUnit: value as WindowUnit })}>
              <SelectTrigger className="h-8 w-[110px] text-sm" aria-label="Window unit">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(UNIT_LABELS) as WindowUnit[]).map((unit) => (
                  <SelectItem key={unit} value={unit}>
                    {UNIT_LABELS[unit]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-wrap gap-1" role="group" aria-label="Methods">
            {RATE_LIMIT_METHODS.map((method) => {
              const active = rule.methods.includes(method);
              return (
                <button
                  key={method}
                  type="button"
                  aria-pressed={active}
                  onClick={() => toggleMethod(i, method)}
                  className={cn(
                    "rounded-md border px-2 py-0.5 text-[0.7rem] font-mono transition-colors",
                    active
                      ? "border-amber-500 bg-amber-500/15 text-amber-700 dark:text-amber-300"
                      : "border-border text-muted-foreground hover:border-muted-foreground"
                  )}
                >
                  {method}
                </button>
              );
            })}
            <span className="text-xs text-muted-foreground self-center ml-1">
              {rule.methods.length === 0 ? "every method" : ""}
            </span>
          </div>
        </div>
      ))}
      <div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={rules.length >= RATE_LIMIT_LIMITS.maxRules}
          onClick={() => onChange([...rules, toState(defaultRateLimitRule())])}
        >
          <Plus className="h-4 w-4 mr-1" />
          Add rule
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Over the limit, a client gets 429 Too Many Requests with Retry-After. Windows run from 1 second
        to 1 hour; at most {RATE_LIMIT_LIMITS.maxEvents} requests per window. Paths are matched as the
        client sent them, before any rewrite.
        {showUserKeyHint && (
          <> Per signed-in user needs this host&apos;s built-in forward auth; elsewhere, and for requests without a
          signed-in user, it counts per client IP. Per request header counts requests without the header per
          client IP.</>
        )}
      </p>
    </div>
  );
}

function ModeSelector({ mode, onChange }: { mode: RateLimitMode; onChange: (mode: RateLimitMode) => void }) {
  return (
    <div className="flex gap-2">
      {(["merge", "override"] as RateLimitMode[]).map((value) => (
        <div
          key={value}
          role="button"
          tabIndex={0}
          aria-pressed={mode === value}
          onClick={() => onChange(value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onChange(value);
            }
          }}
          className={cn(
            "flex-1 py-2 px-3 rounded-xl border-[1.5px] cursor-pointer text-center transition-all duration-150 select-none",
            mode === value ? "border-amber-500 bg-amber-500/10" : "border-border hover:border-muted-foreground"
          )}
        >
          <p
            className={cn(
              "text-sm transition-all duration-150",
              mode === value ? "font-semibold text-amber-700 dark:text-amber-300" : "font-normal text-muted-foreground"
            )}
          >
            {value === "merge" ? "Merge with global" : "Override global"}
          </p>
        </div>
      ))}
    </div>
  );
}

// ─── Proxy host dialog section ───────────────────────────────────────────────

/**
 * The "Rate limiting" section of the proxy host dialog. Posts
 * `rateLimitPresent` and the configuration as JSON in `rateLimitJson`; the
 * model validates it.
 */
export function RateLimitFields({ value }: { value?: ProxyHostRateLimit | null }) {
  const [enabled, setEnabled] = useState(value?.enabled ?? false);
  const [mode, setMode] = useState<RateLimitMode>(value?.mode ?? "merge");
  // A stored configuration is shown as it is (override with no rules is an
  // opt-out); a new one starts from a template rule.
  const [rules, setRules] = useState<RuleState[]>(() =>
    value ? value.rules.map(toState) : [toState(defaultRateLimitRule())]
  );

  // With the switch off and nothing stored, the host keeps inheriting the defaults.
  const payload = enabled || value ? JSON.stringify({ enabled, mode, rules: toRules(rules) }) : "";

  return (
    <div className="rounded-lg border border-amber-500/60 bg-amber-500/5 p-4" data-testid="rate-limit-fields">
      <input type="hidden" name="rateLimitPresent" value="1" />
      <input type="hidden" name="rateLimitJson" value={payload} />

      <div className="flex flex-row items-start justify-between gap-2">
        <div className="flex flex-row items-start gap-3 flex-1 min-w-0">
          <div className="mt-0.5 w-8 h-8 rounded-xl bg-amber-500 flex items-center justify-center shrink-0">
            <Gauge className="h-4 w-4 text-white" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-bold leading-snug">Rate Limiting</p>
            <p className="text-sm text-muted-foreground mt-0.5">
              Answer 429 to clients that send too many requests, by path and method
            </p>
          </div>
        </div>
        <Switch
          checked={enabled}
          onCheckedChange={setEnabled}
          className="shrink-0"
          aria-label="Rate limiting for this host"
        />
      </div>

      {!enabled && (
        <p className="text-xs text-muted-foreground mt-2">
          Off: the host uses the global defaults from Settings, if they are enabled.
        </p>
      )}

      <div
        className={cn(
          "overflow-hidden transition-all duration-200",
          enabled ? "max-h-[6000px] opacity-100 mt-4" : "max-h-0 opacity-0 pointer-events-none"
        )}
      >
        <ModeSelector mode={mode} onChange={setMode} />
        <p className="text-xs text-muted-foreground mt-2">
          {mode === "merge"
            ? "The global default rules apply as well as these."
            : "Only these rules apply. Override with no rules turns rate limiting off for this host."}
        </p>
        <div className="border-t border-border mt-3 mb-3" />
        <RateLimitRulesEditor rules={rules} onChange={setRules} />
      </div>
    </div>
  );
}

// ─── Global settings section ─────────────────────────────────────────────────

/**
 * The global defaults form fields. Posts the settings as JSON in
 * `rateLimitSettingsJson`; the settings action validates it.
 */
export function RateLimitSettingsFields({ value }: { value?: RateLimitSettings | null }) {
  const [enabled, setEnabled] = useState(value?.enabled ?? false);
  const [rules, setRules] = useState<RuleState[]>(() => (value?.rules ?? []).map(toState));
  const [allowlist, setAllowlist] = useState((value?.allowlist ?? []).join("\n"));
  const [ipv6Prefix, setIpv6Prefix] = useState(String(value?.ipv6Prefix ?? RATE_LIMIT_LIMITS.defaultIpv6Prefix));

  const payload = JSON.stringify({
    enabled,
    rules: toRules(rules),
    allowlist: allowlist
      .split(/[\n,]/)
      .map((entry) => entry.trim())
      .filter(Boolean),
    ipv6Prefix: Number(ipv6Prefix),
  });

  return (
    <div className="flex flex-col gap-4" data-testid="rate-limit-settings">
      <input type="hidden" name="rateLimitSettingsJson" value={payload} />
      <div className="flex flex-row items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold">Default rules</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            Apply to every proxy host without rate limiting of its own, and to hosts that merge with them.
            A host that overrides them uses only its own rules.
          </p>
        </div>
        <Switch checked={enabled} onCheckedChange={setEnabled} aria-label="Apply the default rules" />
      </div>
      <RateLimitRulesEditor rules={rules} onChange={setRules} />

      <div className="border-t border-border" />

      <div>
        <label htmlFor="rate-limit-allowlist" className="text-sm font-semibold block">
          Never limited
        </label>
        <p className="text-xs text-muted-foreground mt-0.5 mb-1.5">
          Client IPs and CIDR ranges that no rule limits, such as monitoring probes. One per line;{" "}
          <code className="font-mono">private_ranges</code> covers the private networks. Applies even when the
          default rules are off. Client IPs are resolved through the trusted proxies.
        </p>
        <Textarea
          id="rate-limit-allowlist"
          value={allowlist}
          onChange={(e) => setAllowlist(e.target.value)}
          placeholder={"192.0.2.10\n198.51.100.0/24"}
          rows={3}
          className="font-mono text-sm"
        />
      </div>

      <div>
        <label htmlFor="rate-limit-ipv6-prefix" className="text-sm font-semibold block">
          IPv6 grouping
        </label>
        <p className="text-xs text-muted-foreground mt-0.5 mb-1.5">
          Rules keyed by client IP count IPv6 clients per network of this prefix length, since one subscriber
          usually holds a whole /64. 128 counts every address on its own.
        </p>
        <Input
          id="rate-limit-ipv6-prefix"
          type="number"
          min={RATE_LIMIT_LIMITS.minIpv6Prefix}
          max={RATE_LIMIT_LIMITS.maxIpv6Prefix}
          value={ipv6Prefix}
          onChange={(e) => setIpv6Prefix(e.target.value)}
          className="h-8 w-24 text-sm"
        />
      </div>
    </div>
  );
}
