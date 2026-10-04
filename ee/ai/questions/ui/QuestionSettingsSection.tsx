// SPDX-License-Identifier: Elastic-2.0
"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/button";
import { SectionCard } from "@/components/ui/SectionCard";
import { Switch } from "@/components/ui/switch";
import type { QuestionSettingsView } from "@/ee/ai/questions/types";
import { saveQuestionSettingsAction } from "@/ee/alerting/ui/actions";

type Props = {
  settings: QuestionSettingsView;
  /** The license includes the AI analyst; without it only turning things off works. */
  canConfigure: boolean;
  aiConfigured: boolean;
};

/** Settings of plain-language analytics questions (ee/ai/questions), on Alerts → AI. */
export default function QuestionSettingsSection({ settings, canConfigure, aiConfigured }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [form, setForm] = useState<QuestionSettingsView>(settings);
  const [error, setError] = useState<string | null>(null);
  const changed = (Object.keys(form) as (keyof QuestionSettingsView)[]).some((key) => form[key] !== settings[key]);
  // Without a license, a change may only turn settings off.
  const onlyOff = (Object.keys(form) as (keyof QuestionSettingsView)[]).every((key) => form[key] === settings[key] || form[key] === false);

  function save() {
    setError(null);
    const input = Object.fromEntries((Object.keys(form) as (keyof QuestionSettingsView)[]).filter((key) => form[key] !== settings[key]).map((key) => [key, form[key]]));
    startTransition(async () => {
      const result = await saveQuestionSettingsAction(input);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      toast.success("Question settings saved");
      router.refresh();
    });
  }

  const toggle = (key: keyof QuestionSettingsView, label: string, hint: string) => (
    <label className="flex items-start gap-3 text-sm">
      <Switch
        className="mt-0.5"
        checked={form[key]}
        onCheckedChange={(checked) => setForm({ ...form, [key]: checked })}
        disabled={pending || (!canConfigure && !form[key])}
        aria-label={label}
      />
      <span className="flex flex-col gap-0.5">
        <span>{label}</span>
        <span className="text-xs text-muted-foreground">{hint}</span>
      </span>
    </label>
  );

  return (
    <SectionCard
      title="Analytics questions"
      description="Plain-language questions on the Analytics page, read by this model."
      descriptionPlacement="below"
      padded
      contentClassName="flex flex-col gap-4"
    >
      {!canConfigure && (
        <Banner tone="info">
          Turning questions on needs a license that includes the AI analyst; they can always be turned off.{" "}
          <Link href="/license" className="text-brand underline underline-offset-2">
            Licensing
          </Link>
        </Banner>
      )}
      {!aiConfigured && <p className="m-0 text-[13px] text-muted-foreground">Set up the AI provider first: questions use it.</p>}
      {toggle("enabled", "Let users ask questions", "Anyone who can read analytics, within their organisation and host tags. Every question is recorded in the audit log.")}
      {toggle(
        "aiSummaries",
        "AI-written summaries",
        "The model writes a short summary from the aggregated result. Off, the dashboard writes it and the result is never sent."
      )}
      {toggle(
        "shareRequestDetails",
        "Send client addresses, user agents and paths when a question needs them",
        "Off (the default), they reach the model as placeholders such as [address 1]. The question itself is always sent as typed."
      )}
      {error && (
        <Banner tone="bad" live>
          {error}
        </Banner>
      )}
      <div>
        <Button onClick={save} disabled={pending || !changed || (!canConfigure && !onlyOff)}>
          Save
        </Button>
      </div>
    </SectionCard>
  );
}
