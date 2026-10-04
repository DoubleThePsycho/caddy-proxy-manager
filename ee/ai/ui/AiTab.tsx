// SPDX-License-Identifier: Elastic-2.0
"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Banner } from "@/components/ui/Banner";
import { SectionCard } from "@/components/ui/SectionCard";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { AiProvider, AiSettingsView } from "@/ee/ai/settings";
import type { DigestSettingsView } from "@/ee/ai/types";
import type { AlertChannelView } from "@/ee/alerting/types";
import type { QuestionSettingsView } from "@/ee/ai/questions/types";
import { removeAiSettingsAction, saveAiSettingsAction, testAiProviderAction } from "@/ee/alerting/ui/actions";
import DigestSection from "./DigestSection";
import QuestionSettingsSection from "@/ee/ai/questions/ui/QuestionSettingsSection";

const PROVIDER_LABELS: Record<AiProvider, string> = {
  anthropic: "Anthropic (Claude)",
  openai_compatible: "OpenAI-compatible (Ollama, vLLM, LM Studio, …)",
};

type Props = {
  settings: AiSettingsView;
  canConfigure: boolean;
  digest?: DigestSettingsView;
  channels?: AlertChannelView[];
  questions?: QuestionSettingsView;
};

export default function AiTab({ settings, canConfigure, digest, channels = [], questions }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [enabled, setEnabled] = useState(settings.provider ? settings.enabled : true);
  const [provider, setProvider] = useState<AiProvider>(settings.provider ?? "anthropic");
  const [model, setModel] = useState(settings.model ?? "");
  const [baseUrl, setBaseUrl] = useState(settings.baseUrl ?? "");
  const [apiKey, setApiKey] = useState("");
  const [removeKey, setRemoveKey] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);
  const keyStored = settings.hasApiKey && provider === settings.provider;

  function save() {
    setError(null);
    const input: Record<string, unknown> = { enabled, provider };
    if (model.trim()) input.model = model.trim();
    if (provider === "openai_compatible") input.baseUrl = baseUrl.trim();
    if (removeKey) input.apiKey = null;
    else if (apiKey.trim()) input.apiKey = apiKey.trim();
    startTransition(async () => {
      const result = await saveAiSettingsAction(input);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setApiKey("");
      setRemoveKey(false);
      toast.success("AI provider saved");
      router.refresh();
    });
  }

  function remove() {
    startTransition(async () => {
      const result = await removeAiSettingsAction();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setApiKey("");
      setRemoveKey(false);
      setModel("");
      setBaseUrl("");
      toast.success("AI provider removed");
      router.refresh();
    });
  }

  function test() {
    setTestResult(null);
    startTransition(async () => {
      const result = await testAiProviderAction();
      setTestResult(result.ok ? { ok: true, text: result.message ?? "" } : { ok: false, text: result.error });
    });
  }

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <SectionCard
        title="AI provider"
        actions={settings.configured ? <Badge variant="success">Active</Badge> : <Badge variant="secondary">Not set up</Badge>}
        padded
        contentClassName="flex flex-col gap-4"
      >
          <p className="m-0 text-[13px] text-muted-foreground">
            Rules with AI explanations get 2-4 sentences on what the alert means and what to do next, written by your own
            model from the alert&apos;s facts only.
          </p>
          {!canConfigure && (
            <Banner tone="info">
              Setting up the AI analyst needs a license that includes it; a provider already set up keeps working and can
              still be removed.{" "}
              <Link href="/license" className="text-brand underline underline-offset-2">
                Licensing
              </Link>
            </Banner>
          )}
          <fieldset disabled={!canConfigure || pending} className="flex flex-col gap-4">
            <div className="space-y-1.5">
              <Label>Provider</Label>
              <Select
                value={provider}
                onValueChange={(value) => {
                  setProvider(value as AiProvider);
                  setModel(value === settings.provider ? settings.model ?? "" : "");
                }}
                disabled={!canConfigure}
              >
                <SelectTrigger aria-label="AI provider">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(PROVIDER_LABELS) as AiProvider[]).map((value) => (
                    <SelectItem key={value} value={value}>
                      {PROVIDER_LABELS[value]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ai-model">Model</Label>
              <Input
                id="ai-model"
                value={model}
                onChange={(event) => setModel(event.target.value)}
                placeholder={provider === "anthropic" ? settings.defaultModel : "llama3.1"}
              />
              {provider === "anthropic" && (
                <p className="text-xs text-muted-foreground">Default {settings.defaultModel}. Requests use low effort and are capped at 1024 output tokens.</p>
              )}
            </div>
            {provider === "openai_compatible" && (
              <div className="space-y-1.5">
                <Label htmlFor="ai-base-url">Base URL</Label>
                <Input id="ai-base-url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="http://ollama:11434/v1" />
                <p className="text-xs text-muted-foreground">Requests go to {"{base URL}"}/chat/completions.</p>
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="ai-key">API key{provider === "openai_compatible" ? " (optional)" : ""}</Label>
              <Input
                id="ai-key"
                type="password"
                autoComplete="new-password"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder={keyStored ? "Stored; leave empty to keep" : ""}
                disabled={removeKey || !canConfigure}
              />
              {keyStored && (
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Checkbox checked={removeKey} onCheckedChange={(checked) => setRemoveKey(checked === true)} disabled={!canConfigure} />
                  Remove the stored key
                </label>
              )}
              <p className="text-xs text-muted-foreground">
                Stored encrypted and only sent to this provider; changing the provider or base URL asks for it again.
              </p>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={enabled} onCheckedChange={setEnabled} disabled={!canConfigure} />
              Enabled
            </label>
          </fieldset>
          {error && (
            <Banner tone="bad" live>
              {error}
            </Banner>
          )}
          <div className="flex flex-wrap gap-2">
            <Button onClick={save} disabled={!canConfigure || pending}>
              Save
            </Button>
            <Button variant="outline" onClick={test} disabled={!canConfigure || pending || !settings.configured}>
              Explain a sample alert
            </Button>
            {settings.provider && (
              // Removing the provider always works, with or without a license.
              <Button variant="danger" onClick={remove} disabled={pending}>
                Remove provider
              </Button>
            )}
          </div>
          {testResult &&
            (testResult.ok ? (
              <div role="status" className="rounded-xl border border-line bg-panel2 p-3 text-[13px]">
                <span className="font-semibold">AI-generated explanation: </span>
                <span className="text-muted-foreground">{testResult.text}</span>
              </div>
            ) : (
              <Banner tone="bad" live>
                {testResult.text}
              </Banner>
            ))}
      </SectionCard>

      <SectionCard
        title="What the model sees"
        description="Only structured facts about the alert, never logs or raw requests."
        padded
        contentClassName="flex flex-col gap-2 text-[13px] text-muted-foreground"
      >
          <p>
            For each alert the model receives its type, severity and aggregated facts (for example a certificate&apos;s name
            and expiry date, or blocked-request counts and the top WAF rules). Values that can come from requests or logs, such
            as host names and rule messages, are passed as data the model is told never to follow, and it has no tools.
          </p>
          <p>
            The explanation is appended to the notification, labeled as AI-generated. If the model fails, refuses or takes
            longer than 15 seconds, the alert is sent without it.
          </p>
          <p>
            The daily digest&apos;s summary is written the same way from the digest&apos;s aggregated figures; without it, or
            when the model fails, the plain digest is sent.
          </p>
          <p>
            For analytics questions the model gets the question and the query schema, never SQL to run; the query is checked
            and run here. The summary is written from aggregated figures, with client addresses, user agents and paths as
            placeholders unless you allow them below.
          </p>
      </SectionCard>

      {digest && <DigestSection settings={digest} channels={channels} canConfigure={canConfigure} aiConfigured={settings.configured} />}
      {questions && <QuestionSettingsSection settings={questions} canConfigure={canConfigure} aiConfigured={settings.configured} />}
    </div>
  );
}
