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
import { MAX_AI_TIMEOUT_SECONDS, MIN_AI_TIMEOUT_SECONDS, type DigestSettingsView } from "@/ee/ai/types";
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
  const [timeoutSeconds, setTimeoutSeconds] = useState(String(settings.timeoutSeconds));
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
    // A number when it is one; anything else goes as typed, so the server's range check names the field.
    const seconds = timeoutSeconds.trim();
    input.timeoutSeconds = seconds !== "" && Number.isFinite(Number(seconds)) ? Number(seconds) : seconds;
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
              <p className="text-xs text-muted-foreground">Changing the provider or base URL asks for it again.</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ai-timeout">Timeout (seconds)</Label>
              <Input
                id="ai-timeout"
                type="number"
                inputMode="numeric"
                min={MIN_AI_TIMEOUT_SECONDS}
                max={MAX_AI_TIMEOUT_SECONDS}
                step={1}
                value={timeoutSeconds}
                onChange={(event) => setTimeoutSeconds(event.target.value)}
                className="w-32"
              />
              <p className="text-xs text-muted-foreground">
                {MIN_AI_TIMEOUT_SECONDS} to {MAX_AI_TIMEOUT_SECONDS}. Slow models, such as large self-hosted ones, need more.
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

      <SectionCard title="What the model sees" padded contentClassName="text-[13px] text-muted-foreground">
        <p className="m-0">
          Aggregated facts about the alert, the digest or the question, never logs or raw requests.
          {questions && " Client addresses, user agents and paths stay hidden unless you allow them below."}
        </p>
      </SectionCard>

      {digest && <DigestSection settings={digest} channels={channels} canConfigure={canConfigure} aiConfigured={settings.configured} />}
      {questions && <QuestionSettingsSection settings={questions} canConfigure={canConfigure} aiConfigured={settings.configured} />}
    </div>
  );
}
