// SPDX-License-Identifier: Elastic-2.0
"use client";

import { useId, useRef, useState, useTransition, type ChangeEvent } from "react";
import { useRouter } from "next/navigation";
import { CircleCheck, CircleX, FileKey, TriangleAlert, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { EDITION_FEATURES, EDITION_LABELS, FEATURE_INFO, type Feature } from "@/ee/licensing/features";
import type { LicenseKeyCheck } from "@/ee/licensing/view";
import { installLicenseAction, verifyLicenseAction } from "./actions";
import { formatDay, plural } from "./license-format";

/** A key file is a few hundred bytes; anything much larger is not one. */
export const MAX_KEY_FILE_BYTES = 16 * 1024;
const KEY_PATTERN = /v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/;

type Step =
  | { kind: "idle" }
  | { kind: "error"; message: string }
  | { kind: "checked"; check: LicenseKeyCheck }
  | { kind: "installed"; check: LicenseKeyCheck };

type Tone = "ok" | "warn" | "bad";

const TONE: Record<Tone, { box: string; icon: string; Icon: LucideIcon }> = {
  ok: { box: "bg-ok-tint", icon: "text-ok", Icon: CircleCheck },
  warn: { box: "bg-warn-tint", icon: "text-warn", Icon: TriangleAlert },
  bad: { box: "bg-bad-tint", icon: "text-bad", Icon: CircleX },
};

/** The file's key: the first v1.… token in it (order e-mails saved as text work too), else the whole text. */
export function keyFromFileText(text: string): string {
  return (KEY_PATTERN.exec(text)?.[0] ?? text).trim();
}

/** What the result box says about a checked key, before it is installed. */
export function describeCheck(
  check: LicenseKeyCheck,
  context: { hasLicense: boolean; nodesUsed: number; inUse: readonly Feature[] }
): { tone: Tone; title: string; body: string; notes: string[] } {
  if (!check.installable || !check.edition) {
    if (check.status === "expired" && check.expiresAt) {
      return {
        tone: "bad",
        title: `This license expired on ${formatDay(check.expiresAt)}`,
        body: "A key past its 30-day grace period cannot be installed. The current key is unchanged.",
        notes: [],
      };
    }
    const malformed = !check.error || check.error === "The license key is not valid";
    return {
      tone: "bad",
      title: check.error ?? "The license key is not valid",
      body: malformed
        ? "Paste the whole key: it starts with v1. and has two dots. The current key is unchanged."
        : "The current key is unchanged.",
      notes: [],
    };
  }
  const summary = [
    EDITION_LABELS[check.edition],
    check.nodes !== null ? plural(check.nodes, "node", "nodes") : null,
    check.customer,
    check.expiresAt ? `valid until ${formatDay(check.expiresAt)}` : null,
    check.trial ? "trial" : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const notes: string[] = [];
  const edition = check.edition;
  // Features added to the key on top of its edition's.
  const extra = check.features.filter((feature) => !EDITION_FEATURES[edition].includes(feature));
  if (extra.length > 0) notes.push(`Also grants ${extra.map((feature) => FEATURE_INFO[feature].label).join(", ")}.`);
  const missing = context.inUse.filter((feature) => !check.features.includes(feature));
  if (missing.length > 0) {
    notes.push(
      `Not in this key but set up here: ${missing.map((feature) => FEATURE_INFO[feature].label).join(", ")}. They keep running, read-only.`
    );
  }
  if (check.nodes !== null && context.nodesUsed > check.nodes) {
    notes.push(
      `This dashboard manages ${plural(context.nodesUsed, "node", "nodes")}; the key covers ${check.nodes}. Nothing is blocked; the extra nodes are due from the next renewal.`
    );
  }
  if (check.online) {
    notes.push("Online key: confirmed with the license server once a day.");
  }
  const replaces = context.hasLicense ? "Installing it replaces the current key at once." : "Installing it unlocks its paid features at once.";
  if (check.status === "revoked") {
    return {
      tone: "bad",
      title: "The license server reports this license as revoked",
      body: `${summary}. Installed, its paid settings stay read-only. Questions: sales@ingres.si.`,
      notes,
    };
  }
  if (check.status === "unconfirmed") {
    return {
      tone: "warn",
      title: `Signature verified${check.keyId ? ` with public key ${check.keyId}` : ""}, but the license is not confirmed`,
      body: `${summary}. The license server has not confirmed it to this install; paid settings stay read-only until it does. ${replaces}`,
      notes,
    };
  }
  if (check.status === "grace" && check.graceEndsAt) {
    return {
      tone: "warn",
      title: `Signature verified${check.keyId ? ` with public key ${check.keyId}` : ""}, but the license has expired`,
      body: `${summary}. Its grace period ends on ${formatDay(check.graceEndsAt)}; paid features turn read-only after that. ${replaces}`,
      notes,
    };
  }
  return {
    tone: "ok",
    title: `Signature verified${check.keyId ? ` with public key ${check.keyId}` : ""}`,
    body: `${summary}. ${replaces}`,
    notes,
  };
}

export type InstallKeyCardProps = {
  hasLicense: boolean;
  nodesUsed: number;
  /** Paid features set up on this install. */
  inUse: readonly Feature[];
};

/** Paste or choose a key, check it on this machine, then install it. */
export function InstallKeyCard({ hasLicense, nodesUsed, inUse }: InstallKeyCardProps) {
  const router = useRouter();
  const headingId = useId();
  const textareaId = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [file, setFile] = useState<{ name: string; key: string } | null>(null);
  const [step, setStep] = useState<Step>({ kind: "idle" });
  const [pending, startTransition] = useTransition();

  const key = (file ? file.key : text).trim();
  const hasInput = key.length > 0;

  function changeText(event: ChangeEvent<HTMLTextAreaElement>) {
    setText(event.target.value);
    setFile(null);
    setStep({ kind: "idle" });
  }

  async function pickFile(event: ChangeEvent<HTMLInputElement>) {
    const picked = event.target.files?.[0];
    setStep({ kind: "idle" });
    if (!picked) {
      setFile(null);
      return;
    }
    if (picked.size > MAX_KEY_FILE_BYTES) {
      setFile(null);
      event.target.value = "";
      setStep({ kind: "error", message: "That file is too large to be a license key file. Key files are a few hundred bytes." });
      return;
    }
    try {
      const content = await picked.text();
      setFile({ name: picked.name, key: keyFromFileText(content) });
      setText("");
    } catch {
      setFile(null);
      setStep({ kind: "error", message: "That file could not be read." });
    }
  }

  function reset() {
    setText("");
    setFile(null);
    setStep({ kind: "idle" });
    if (fileInput.current) fileInput.current.value = "";
  }

  function verify() {
    if (!hasInput) return;
    startTransition(async () => {
      const result = await verifyLicenseAction(key);
      setStep("error" in result ? { kind: "error", message: result.error } : { kind: "checked", check: result.check });
    });
  }

  function install(check: LicenseKeyCheck) {
    const formData = new FormData();
    formData.set("key", key);
    startTransition(async () => {
      const result = await installLicenseAction(formData);
      if ("error" in result) {
        setStep({ kind: "error", message: result.error });
        return;
      }
      setStep({ kind: "installed", check });
      setText("");
      setFile(null);
      if (fileInput.current) fileInput.current.value = "";
      router.refresh();
    });
  }

  const result =
    step.kind === "error"
      ? { tone: "bad" as Tone, title: step.message, body: "The current key is unchanged.", notes: [] as string[] }
      : step.kind === "checked"
        ? describeCheck(step.check, { hasLicense, nodesUsed, inUse })
        : step.kind === "installed"
          ? {
              tone: "ok" as Tone,
              title: "Installed",
              body: `The ${step.check.editionLabel ?? "new"} key is active. Paid features you set up keep running as before.`,
              notes: [] as string[],
            }
          : null;
  const installable = step.kind === "checked" && step.check.installable;

  return (
    <section
      aria-labelledby={headingId}
      className="flex min-w-0 flex-[1_1_320px] flex-col gap-3 rounded-2xl border border-line bg-panel px-5 pt-[18px] pb-5"
    >
      <div className="flex flex-col gap-1">
        <h2 id={headingId} className="m-0 text-base leading-6 font-semibold">
          {hasLicense ? "Install a new key" : "Install a key"}
        </h2>
        {hasLicense && <p className="m-0 text-[13px] text-muted-foreground">Replaces the current key.</p>}
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={textareaId} className="font-medium">
          License key
        </label>
        <Textarea
          id={textareaId}
          rows={5}
          value={text}
          onChange={changeText}
          placeholder="v1.eyJ…"
          spellCheck={false}
          autoComplete="off"
          className="num resize-y bg-background text-xs leading-[18px] [overflow-wrap:anywhere] md:text-xs"
        />
      </div>
      <div aria-hidden="true" className="flex items-center gap-2.5 text-xs text-soft">
        <span className="h-px flex-1 bg-line" />
        or
        <span className="h-px flex-1 bg-line" />
      </div>
      <label className="relative flex cursor-pointer items-center gap-3 rounded-lg border border-dashed border-line2 px-3.5 py-3 transition-colors focus-within:border-brand hover:bg-panel2">
        <span aria-hidden="true" className="grid h-8 w-8 flex-none place-items-center rounded-lg bg-raise text-muted-foreground">
          <FileKey className="h-4 w-4" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate font-medium">{file ? file.name : "Choose a key file"}</span>
          <span className="text-xs text-soft">{file ? "Ready to verify" : "A .txt, .key or .lic file from your order e-mail"}</span>
        </span>
        <input ref={fileInput} type="file" accept=".txt,.key,.lic,text/plain" onChange={pickFile} className="sr-only" />
      </label>

      <div role="status" aria-live="polite">
        {result && (
          <div className={cn("flex items-start gap-2.5 rounded-lg border border-line2 px-3 py-2.5 text-[13px]", TONE[result.tone].box)}>
            {(() => {
              const Icon = TONE[result.tone].Icon;
              return <Icon aria-hidden="true" className={cn("mt-0.5 h-4 w-4 shrink-0", TONE[result.tone].icon)} />;
            })()}
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="font-semibold [overflow-wrap:anywhere]">{result.title}</span>
              <span className="text-muted-foreground">{result.body}</span>
              {result.notes.map((note) => (
                <span key={note} className="text-muted-foreground">
                  {note}
                </span>
              ))}
            </span>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2.5">
        {installable ? (
          <Button type="button" onClick={() => install((step as { check: LicenseKeyCheck }).check)} disabled={pending}>
            {pending ? "Installing…" : "Install key"}
          </Button>
        ) : (
          <Button type="button" onClick={verify} disabled={!hasInput || pending || step.kind === "installed"}>
            {pending ? "Checking…" : "Verify key"}
          </Button>
        )}
        {step.kind !== "idle" && (
          <Button type="button" variant="ghost" onClick={reset} disabled={pending}>
            Start over
          </Button>
        )}
      </div>
    </section>
  );
}
