"use client";

import { useId, useState, useTransition } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { ChartColumn, CircleCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { UsagePingPayload } from "@/src/lib/usage-ping/payload";
import { previewUsagePingAction, setUsagePingEnabledAction } from "./settings/usage-ping-actions";

const ANSWERED: Record<"yes" | "no", string> = {
  yes: "Thank you. The usage ping is on and the first one goes out in a few minutes; Settings shows what it sends and turns it off.",
  no: "The usage ping stays off and you will not be asked again. Settings turns it on if you change your mind.",
};

/**
 * Asked of administrators on the overview page until one of them answers.
 * Both answers look alike and neither is preselected; nothing is sent before
 * a yes. Closing the page without answering just asks again next time.
 */
export default function UsagePingQuestion() {
  const titleId = useId();
  const [answered, setAnswered] = useState<"yes" | "no" | null>(null);
  const [payload, setPayload] = useState<UsagePingPayload | null>(null);
  const [showPayload, setShowPayload] = useState(false);
  const [pending, startTransition] = useTransition();

  if (answered) {
    return (
      <div role="status" className="flex flex-wrap items-center gap-x-3.5 gap-y-2.5 rounded-xl border border-line bg-panel px-4 py-3">
        <CircleCheck aria-hidden="true" className="h-[18px] w-[18px] shrink-0 text-ok" />
        <span className="min-w-0 flex-[1_1_360px]">{ANSWERED[answered]}</span>
        <Link href="/settings?section=usage-ping" className="text-[13px] text-brand underline-offset-4 hover:underline">
          Usage ping settings
        </Link>
      </div>
    );
  }

  function answer(enabled: boolean) {
    startTransition(async () => {
      const result = await setUsagePingEnabledAction(enabled);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      setAnswered(enabled ? "yes" : "no");
    });
  }

  function togglePreview() {
    if (payload) {
      setShowPayload((shown) => !shown);
      return;
    }
    startTransition(async () => {
      setPayload((await previewUsagePingAction()).payload);
      setShowPayload(true);
    });
  }

  // Both answers share one look: neither is the primary button.
  const answerClass = "h-9 min-w-[148px] rounded-[10px] border-line2 px-3.5 font-semibold";
  return (
    <section
      aria-labelledby={titleId}
      className="flex flex-col gap-3.5 rounded-2xl border border-line bg-panel px-5 py-[18px]"
      data-testid="usage-ping-question"
    >
      <div className="flex items-start gap-3.5">
        <span aria-hidden="true" className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px] bg-brand-tint text-brand">
          <ChartColumn className="h-[18px] w-[18px]" strokeWidth={2} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h2 id={titleId} className="m-0 text-base leading-6 font-semibold">
            Share anonymous usage statistics?
          </h2>
          <p className="m-0 max-w-[780px] text-muted-foreground text-pretty">
            If you say yes, once a day this install tells the developers its version, edition and rough size (ranges such as{" "}
            <span className="num">6-20</span> hosts) and which features are in use, under a random id. Never hostnames, domains, IP
            addresses, e-mails, names, configuration or logs. Nothing is sent unless you say yes, and you can change your answer at any time
            in Settings; turning it off asks for what was received to be deleted.
          </p>
        </div>
      </div>
      {payload && showPayload && (
        <div className="flex flex-col gap-1.5 md:ml-[50px]">
          <span className="text-xs text-soft">The document the next ping would send, built by the same code that sends it:</span>
          <pre className="num m-0 max-h-[300px] overflow-auto rounded-[10px] border border-line bg-panel2 px-3.5 py-3 text-xs leading-[18px] whitespace-pre text-foreground">
            {JSON.stringify(payload, null, 2)}
          </pre>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2 md:ml-[50px]">
        <Button variant="secondary" className={answerClass} disabled={pending} onClick={() => answer(true)}>
          Yes, share
        </Button>
        <Button variant="secondary" className={answerClass} disabled={pending} onClick={() => answer(false)}>
          No, don&apos;t share
        </Button>
        <Button variant="link" className="h-9 px-3" disabled={pending} onClick={togglePreview} aria-expanded={Boolean(payload && showPayload)}>
          {payload && showPayload ? "Hide what is sent" : "See exactly what is sent"}
        </Button>
        <Link href="/settings?section=usage-ping" className="ml-auto text-[13px] text-brand underline-offset-4 hover:underline">
          Privacy details in Settings
        </Link>
      </div>
    </section>
  );
}
