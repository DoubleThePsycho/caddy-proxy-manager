"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { SectionCard } from "@/components/ui/SectionCard";
import type { DefaultResponseSettings, GeneralSettings } from "@/lib/settings";
import { cn } from "@/lib/utils";
import { updateDefaultResponseSettingsAction, updateGeneralSettingsAction } from "../actions";
import { CardNote, ChoiceField, OverrideRow, SettingRow, SettingRows, SettingsForm, SettingsGroupForms } from "@/src/components/settings/settings-form";

type Mode = DefaultResponseSettings["mode"];

const ANSWERS: readonly { value: Mode; label: string; description: string }[] = [
  { value: "caddy", label: "Caddy default", description: "Caddy's own answer, with no custom page." },
  { value: "respond", label: "Custom response", description: "A status code, body and headers you choose." },
  { value: "redirect", label: "Redirect", description: "Send the visitor to another address." },
  { value: "abort", label: "Close the connection", description: "No status line and no body, like nginx 444." },
];

const REDIRECT_STATUSES = ["301", "302", "303", "307", "308"] as const;
type RedirectStatus = (typeof REDIRECT_STATUSES)[number];

export default function GeneralGroup({
  general,
  defaultResponse,
  baseUrl,
  isSlave,
  overrides,
  canSave,
  onDirtyChange,
}: {
  general: GeneralSettings | null;
  defaultResponse: DefaultResponseSettings | null;
  baseUrl: string;
  isSlave: boolean;
  overrides: { general: boolean; defaultResponse: boolean };
  canSave: boolean;
  onDirtyChange: (count: number) => void;
}) {
  return (
    <SettingsGroupForms name="General" canSave={canSave} onDirtyChange={onDirtyChange}>
      <DefaultsCard general={general} baseUrl={baseUrl} isSlave={isSlave} override={overrides.general} />
      <UnknownHostsCard defaultResponse={defaultResponse} isSlave={isSlave} override={overrides.defaultResponse} />
    </SettingsGroupForms>
  );
}

function DefaultsCard({ general, baseUrl, isSlave, override: initialOverride }: { general: GeneralSettings | null; baseUrl: string; isSlave: boolean; override: boolean }) {
  const [override, setOverride] = useState(initialOverride);
  const disabled = isSlave && !override;
  return (
    <SectionCard title="Defaults" headingLevel={3} divided={false}>
      <SettingsForm action={updateGeneralSettingsAction} order={0}>
        <SettingRows>
          {isSlave && <OverrideRow id="general-override" checked={override} onCheckedChange={setOverride} />}
          <SettingRow label="Primary domain" htmlFor="settings-primary-domain" hint="Suggested when you create a proxy host.">
            <Input
              id="settings-primary-domain"
              name="primaryDomain"
              defaultValue={general?.primaryDomain ?? "ingressi.localhost"}
              required
              disabled={disabled}
              className="num w-[320px] max-w-full"
            />
          </SettingRow>
          {/* The contact e-mail is edited under Certificates and ACME; the action saves both. */}
          <input type="hidden" name="acmeEmail" value={general?.acmeEmail ?? ""} data-untracked="" />
          <SettingRow label="Dashboard address" note="Set by BASE_URL in the environment. Sign-in links and OAuth callbacks use it.">
            <span className="num flex min-h-9 items-center text-[13px] [overflow-wrap:anywhere]">{baseUrl}</span>
          </SettingRow>
        </SettingRows>
      </SettingsForm>
    </SectionCard>
  );
}

function UnknownHostsCard({
  defaultResponse,
  isSlave,
  override: initialOverride,
}: {
  defaultResponse: DefaultResponseSettings | null;
  isSlave: boolean;
  override: boolean;
}) {
  const [override, setOverride] = useState(initialOverride);
  const [mode, setMode] = useState<Mode>(defaultResponse?.mode ?? "caddy");
  const [redirectStatus, setRedirectStatus] = useState<RedirectStatus>(() => {
    const stored = defaultResponse?.mode === "redirect" ? String(defaultResponse.status ?? 302) : "302";
    return (REDIRECT_STATUSES as readonly string[]).includes(stored) ? (stored as RedirectStatus) : "302";
  });
  const disabled = isSlave && !override;
  const initialHeaders = Object.entries(defaultResponse?.headers ?? {})
    .map(([name, value]) => `${name}: ${value}`)
    .join("\n");

  return (
    <SectionCard
      id="settings-unknown-hosts"
      className="scroll-mt-4"
      title="Requests for unknown hosts"
      description="Used only when no proxy host matches, for example a visit to the server's bare IP address."
      headingLevel={3}
      divided={false}
    >
      <SettingsForm action={updateDefaultResponseSettingsAction} order={1}>
        <SettingRows>
          {isSlave && <OverrideRow id="default-response-override" checked={override} onCheckedChange={setOverride} />}
          <SettingRow label="Answer with" labelId="settings-answer-with">
            <div role="radiogroup" aria-labelledby="settings-answer-with" className="grid w-full grid-cols-[repeat(auto-fit,minmax(min(230px,100%),1fr))] gap-2">
              {ANSWERS.map((answer) => {
                const checked = mode === answer.value;
                return (
                  <label
                    key={answer.value}
                    className={cn(
                      "flex cursor-pointer items-start gap-2.5 rounded-[10px] border px-3 py-2.5 transition-colors",
                      checked ? "border-brand bg-brand-tint" : "border-line hover:bg-panel2",
                      disabled && "cursor-not-allowed opacity-60"
                    )}
                  >
                    <input
                      type="radio"
                      name="mode"
                      value={answer.value}
                      checked={checked}
                      onChange={() => setMode(answer.value)}
                      disabled={disabled}
                      className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--brand-fill)]"
                    />
                    <span className="flex flex-col gap-0.5">
                      <span className="font-medium">{answer.label}</span>
                      <span className="text-xs leading-4 text-soft">{answer.description}</span>
                    </span>
                  </label>
                );
              })}
            </div>
          </SettingRow>

          {mode === "respond" && (
            <>
              <SettingRow label="Status code" htmlFor="settings-default-status" hint="Any final status from 200 to 599.">
                <Input
                  key="default-response-status"
                  id="settings-default-status"
                  name="status"
                  type="number"
                  min={200}
                  max={599}
                  defaultValue={defaultResponse?.mode === "respond" ? defaultResponse.status ?? 404 : 404}
                  required
                  disabled={disabled}
                  className="num w-[120px]"
                />
              </SettingRow>
              <SettingRow
                label="Response body"
                htmlFor="settings-default-body"
                hint="Text, JSON or HTML. Request placeholders such as {http.request.host} are filled in; {env.*}, {system.*} and {file.*} are sent as written."
              >
                <Textarea
                  id="settings-default-body"
                  name="body"
                  defaultValue={defaultResponse?.mode === "respond" ? defaultResponse.body ?? "" : ""}
                  rows={3}
                  disabled={disabled}
                  placeholder="Not found"
                  className="num min-h-0"
                />
              </SettingRow>
            </>
          )}

          {mode === "redirect" && (
            <>
              <SettingRow label="Redirect status" labelId="settings-redirect-status" hint="307 and 308 keep the request method.">
                <ChoiceField
                  name="status"
                  label="Redirect status"
                  value={redirectStatus}
                  onChange={setRedirectStatus}
                  options={REDIRECT_STATUSES.map((status) => ({ value: status, label: status }))}
                  disabled={disabled}
                />
              </SettingRow>
              <SettingRow
                label="Redirect to"
                htmlFor="settings-redirect-url"
                hint="An absolute or relative address. {http.request.uri} keeps the path and query."
              >
                <Input
                  id="settings-redirect-url"
                  name="redirectUrl"
                  defaultValue={defaultResponse?.mode === "redirect" ? defaultResponse.redirectUrl ?? "" : ""}
                  required
                  disabled={disabled}
                  placeholder="https://example.com{http.request.uri}"
                  className="num"
                />
              </SettingRow>
            </>
          )}

          {(mode === "respond" || mode === "redirect") && (
            <SettingRow
              label="Response headers"
              htmlFor="settings-default-headers"
              hint="Name: value, one per line. For HTML, set Content-Type: text/html; charset=utf-8."
            >
              <Textarea
                key={`default-response-headers-${mode}`}
                id="settings-default-headers"
                name="headers"
                defaultValue={
                  defaultResponse?.mode === mode ? initialHeaders : mode === "respond" ? "Content-Type: text/plain; charset=utf-8" : ""
                }
                rows={2}
                disabled={disabled}
                placeholder={"Content-Type: text/html; charset=utf-8\nCache-Control: no-store"}
                className="num min-h-0"
              />
            </SettingRow>
          )}
        </SettingRows>
      </SettingsForm>
      {mode === "abort" ? (
        <CardNote tone="warn">Caddy closes these connections without writing a status line or body.</CardNote>
      ) : (
        <CardNote>Configured hosts always run first. Over HTTPS, an unknown name can fail at the TLS handshake before any answer is sent.</CardNote>
      )}
    </SectionCard>
  );
}
